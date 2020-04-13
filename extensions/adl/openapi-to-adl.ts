/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { items, values, Dictionary } from "@azure-tools/linq";

import { Project, JSDocStructure, SourceFile, InterfaceDeclaration, EnumDeclaration, Type, VariableDeclarationKind, IndentationText, QuoteKind } from 'ts-morph';
import { pascalCase, TextWithRegions, camelCase } from '@azure-tools/codegen';

import { Host, startSession, Session } from '@azure-tools/autorest-extension-base';

import * as OpenAPI from '@azure-tools/openapi';
import { dereference, JsonType, isReference, Model as oai3, IntegerFormat, NumberFormat, StringFormat } from '@azure-tools/openapi';


type TypeReference = { getName: () => string, getSourceFile?: (() => SourceFile), applyImport?: (file: SourceFile) => void }

function quoteForIdentifier(value: string) {
  return /[^\w]/g.exec(value) ? `'${value}'` : value;
}

export function getValidEnumValueName(originalString: string): string {

  return pascalCase(originalString.split('').map(x => specialCharacterMapping[x] || x).join(''))
}

// ref: https://www.w3schools.com/charsets/ref_html_ascii.asp
const specialCharacterMapping: { [character: string]: string } = {
  '!': 'exclamation mark',
  '"': 'quotation mark',
  '#': 'number sign',
  '$': 'dollar sign',
  '%': 'percent sign',
  '&': 'ampersand',
  '\'': 'apostrophe',
  '(': 'left parenthesis',
  ')': 'right parenthesis',
  '*': 'asterisk',
  '+': 'plus sign',
  ',': 'comma',
  '-': 'hyphen',
  '.': 'dot',
  '/': 'slash',
  ':': 'colon',
  ';': 'semicolon',
  '<': 'less-than',
  '=': 'equals-to',
  '>': 'greater-than',
  '?': 'question mark',
  '@': 'at sign',
  '[': 'left square bracket',
  '\\': 'backslash',
  ']': 'right square bracket',
  '^': 'caret',
  '_': 'underscore',
  '`': 'grave accent',
  '{': 'left curly brace',
  '|': 'vertical bar',
  '}': 'right curly brace',
  '~': 'tilde'
}

function docDescription(value?: string) {
  return [{ description: `${value || ""}\n` }]
}


export async function processRequest(host: Host) {
  const debug = await host.GetValue('debug') || false;

  try {
    const session = await startSession<oai3>(host);

    // process
    const plugin = await new AdlGenerator(session).init();

    // const input = plugin.input;
    // go!
    const result = await plugin.process();

    // throw on errors.
    if (!await session.getValue('ignore-errors', false)) {
      session.checkpoint();
    }


    session.writeFile('tsconfig.json', JSON.stringify({
      // pick up the configuraton from the adl.types package. 
      "extends": "./node_modules/@azure-tools/adl.types/config.json",
      // all *.adl.ts files
      "include": [
        "**/*.ts"
      ],
    }, undefined, 2), undefined, 'source-file-adl');

    session.writeFile('package.json', JSON.stringify({
      "name": session.model.info.title.replace(/[^a-zA-Z]/g, ''),
      "version": "1.0.0",
      "dependencies": {
        "@azure-tools/adl.types": "https://github.com/fearthecowboy/adl.types"
      }
    }, undefined, 2), undefined, 'source-file-adl');

    // host.WriteFile('prechecked-openapi-document.yaml', serialize(result), undefined, 'prechecked-openapi-document');
    // host.WriteFile('original-openapi-document.yaml', serialize(input), undefined, 'openapi-document');
  } catch (E) {
    // if (debug) {
    console.error(`${__filename} - FAILURE  ${JSON.stringify(E)} ${E.stack}`);
    // }
    throw E;
  }
}


class AdlGenerator {

  //   state!: ModelState<OpenAPI.Model>;
  project = new Project({
    useInMemoryFileSystem: true, manipulationSettings: {
      indentationText: IndentationText.TwoSpaces,
      insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces: true,
      quoteKind: QuoteKind.Single,
    }
  });

  protected processed = new Map<any, any>();
  protected models = this.project.createDirectory('models');
  protected enums = this.project.createDirectory('enums');
  protected operations = this.project.createDirectory('operations');
  protected op = 0;
  options!: any;

  get model() {
    return this.session.model;
  }

  constructor(protected session: Session<oai3>) {
  }

  async init() {
    this.options = await this.session.getValue('adl', {});
    return this;
  }

  async generateMain() {
    const title = this.model.info.title || "Service";
    const file = this.project.createSourceFile(`${title}.ts`);

    const scope = file.addNamespace({
      name: title,
      docs: docDescription(this.model.info.description)
    });

    // api versions 
    const apiVersions = scope.addEnum({
      name: "ApiVersions",
      isExported: true,
      docs: docDescription(`API Versions available via the ${title} service.`),
      members: this.model.info['x-ms-metadata'].apiVersions.map((version: string) => ({ name: quoteForIdentifier(version), value: version })),
    });
  }


  async processSchemas() {
    if (this.model.components && this.model.components.schemas) {

      for (const schema of values(this.model.components.schemas).linq
        .select(schema => dereference(this.model, schema).instance)
        //.where(schema => schema.type === JsonType.Object || !!schema.properties)
      ) {
        this.acquireTypeForSchema(schema)
        // this.generateSchema(schema)
      }
    }
  }

  schemaName(schema: OpenAPI.Schema) {
    return pascalCase(schema['x-ms-metadata'].name);
  }

  createFile(schema: OpenAPI.Schema): SourceFile {
    const modelName: string = pascalCase(schema['x-ms-metadata'].name);
    const filename = `${modelName}.ts`;
    if (schema.enum) {
      return this.enums.getSourceFile(filename) || this.enums.createSourceFile(filename);
    }
    return this.models.getSourceFile(filename) || this.models.createSourceFile(filename);
  }

  createInterface(schema: OpenAPI.Schema, file?: SourceFile, modelName?: string, internal?: boolean): InterfaceDeclaration {
    modelName = modelName || pascalCase(schema['x-ms-metadata'].name);
    file = file || this.createFile(schema);

    const container = internal ? file.addNamespace({ name: 'internal' }) : file;

    const iface = container.addInterface({ name: modelName, isExported: true, docs: docDescription(schema.description) });
    if (!internal) {
      this.processed.set(schema, iface);
    }
    if (schema.properties) {
      for (const { key: propertyName, value: propertySchema } of items(schema.properties)) {
        const pSchema = <OpenAPI.Schema>dereference(this.model, propertySchema).instance;
        const type = this.addImportFor(file, this.acquireTypeForSchema(pSchema));
        const property = iface.addProperty({
          name: quoteForIdentifier(propertyName),
          type: type.getName(),
          hasQuestionToken: !(values(schema.required).any(each => each === propertyName)),
          docs: docDescription(propertySchema.description || pSchema.description),
          isReadonly: pSchema.readOnly
        })
        if (pSchema.deprecated) {
          property.addJsDoc('\n@deprecated')
        }
        if (pSchema.default) {
          property.addJsDoc(`\n@default: ${pSchema.default} `);
        }
      }
    }

    return iface;
  }

  addImportFor(file: SourceFile, item: any): TypeReference {

    if (file.getImportDeclarations().length > 0) {
      for (const id of file.getImportDeclarations()) {

        if (id.getNamedImports().find(each => each.getName() === item.getName())) {
          return item;
        }
      }
    }
    if (item.applyImport) {
      item.applyImport(file);
    }
    if (item.getSourceFile) {
      file.addImportDeclaration({
        namedImports: [item.getName()],
        moduleSpecifier: file.getRelativePathAsModuleSpecifierTo(item.getSourceFile())
      });
    }

    return item;
  }

  forwardTypeReference(reference: TypeReference) {
    const sf = reference.getSourceFile ? reference.getSourceFile() : undefined;

    return reference.applyImport || sf ? (f: SourceFile) => {
      const ids = f.getImportDeclarations();
      if (ids && ids.length > 0) {
        for (const each of ids) {
          if (each.getNamedImports().find(ni => ni.getName() === reference.getName())) {
            return;
          }
        }
      }
      f.addImportDeclaration({
        namedImports: [reference.getName()],
        moduleSpecifier: f.getRelativePathAsModuleSpecifierTo(<any>sf)
      })
    } : undefined
  }

  createTypeAlias(schema: OpenAPI.Schema) {
    const file = this.createFile(schema);
    const typeAlias = file.addTypeAlias({
      name: this.schemaName(schema),
      isExported: true,
      type: 'undefined'
    });
    // this is the exported type, make sure it's set asap.
    this.processed.set(schema, typeAlias);
    return typeAlias
  }

  createIntersectionType(schema: OpenAPI.Schema) {
    const typeAlias = this.createTypeAlias(schema);
    const file = this.createFile(schema);

    const allOf = this.deref(schema.allOf).select(a => this.addImportFor(file, this.acquireTypeForSchema(a))).toArray().joinWith(each => each.getName(), '&');
    const oneOf = this.deref(schema.oneOf).select(a => this.addImportFor(file, this.acquireTypeForSchema(a))).toArray().joinWith(each => each.getName(), '|');
    const anyOfCombinations = combinations(this.deref(schema.anyOf).select(a => this.addImportFor(file, this.acquireTypeForSchema(a))).toArray());
    const anyOf = anyOfCombinations.map(s => s.joinWith(each => each.getName(), '&')).join('|');
    let set = allOf;
    if (oneOf) {
      set = set ? `${set} & (${oneOf})` : oneOf;
    }
    if (anyOf) {
      set = set ? `${set} | (${anyOf})` : anyOf;
    }
    if (schema.properties) {
      const iface = this.createInterface(schema, file, this.schemaName(schema), true);
      set = `internal.${iface.getName()} & ${set}`
    }

    typeAlias.setType(set);
    return typeAlias;
  }

  @cache
  acquireTypeForSchema(schema: OpenAPI.Schema): TypeReference {
    if (this.processed.has(schema)) {
      return this.processed.get(schema);
    }
    // if the schema is an 
    // allOf/anyOf/oneOf 
    // or has properties and has 'AdditionalProperties'
    //  the target type must be a union/intersection type
    // 
    // and the underlying schema is 'internal' to that.

    if (schema.allOf || schema.anyOf || schema.oneOf) {
      return this.createIntersectionType(schema);
    }

    if (schema.additionalProperties) {
      // this is some kind of additional properties model

      if (values(schema.properties).any()) {
        // it has some declared properties too.
        // create the interface as internal, and 
        // add an alias
        const typeAlias = this.createTypeAlias(schema);
        const iface = this.createInterface(schema, undefined, undefined, true);

        if (schema.additionalProperties === true) {
          typeAlias.setType(`internal.${iface.getName()} & AdditionalProperties<any>`);
        } else {
          const t = this.acquireTypeForSchema(dereference(this.model, schema.additionalProperties).instance)
          typeAlias.setType(`internal.${iface.getName()} & AdditionalProperties<${t.getName()}>`);
          return typeAlias;
        }
      }

      if (schema.additionalProperties === true) {
        // this type is literally just AdditionalProperties<any>
        return { getName: () => "Dictionary<any>" };
      }

      if (isReference(schema.additionalProperties)) {
        const t = this.acquireTypeForSchema(dereference(this.model, schema.additionalProperties).instance)
        return {
          getName: () => `Dictionary<${t.getName()}>`,
          applyImport: this.forwardTypeReference(t)
        }
      }
    }
    if (schema.enum && schema.type === JsonType.Integer) {
      // hack -- just do integer for now.
      delete schema.enum;
    }
    if (schema.enum && schema.enum.length > 1) {
      return this.createEnum(schema);
    }
    if (schema.properties || schema.type === JsonType.Object) {
      return this.createInterface(schema)
    }

    switch (schema.type) {
      case JsonType.Number:
        return { getName: () => and(this.getPrimitiveFormat(schema), maximum(schema.maximum, schema.exclusiveMaximum), minimum(schema.minimum, schema.exclusiveMaximum)) };

      case JsonType.Integer:
        return { getName: () => and(this.getPrimitiveFormat(schema), maximum(schema.maximum, schema.exclusiveMaximum), minimum(schema.minimum, schema.exclusiveMaximum)) };

      case JsonType.Boolean:
        return { getName: () => "boolean" };

      case JsonType.String:
        if (schema.enum && schema.enum.length === 1) {
          return { getName: () => `Http.Constant<'${(<any>schema.enum)[0]}'>` };
        }
        return { getName: () => and(this.getPrimitiveFormat(schema), maxLength(schema.maxLength), minLength(schema.minLength), pattern(schema.pattern)) };

      case JsonType.Array:
        if (schema.items) {
          const i = dereference(this.model, schema.items).instance;
          if (i) {
            const r = this.acquireTypeForSchema(i);
            return {
              getName: () => `${schema.uniqueItems ? 'Set' : 'Array'}<${r.getName()}>`,
              applyImport: this.forwardTypeReference(r)
            }
          }
        }
    }
    throw new Error(`NoType! ${JSON.stringify(schema, undefined, 2)}`)

  }

  getPrimitiveFormat(schema: OpenAPI.Schema): string {
    switch (schema.type) {
      case JsonType.Integer:
        schema.format = schema.format ? schema.format.toLowerCase() : schema.format;
        switch (schema.format) {
          case IntegerFormat.UnixTime:
            return 'unixtime';

          case IntegerFormat.Int64:
            return 'int64';

          case IntegerFormat.Int32:
            return 'int32';

          case IntegerFormat.None:
          case undefined:
            return 'int64';

          case NumberFormat.Double:
            return 'double';

          case NumberFormat.Float:
            return 'float'

          case NumberFormat.Decimal:
            return 'double';

          default:
            this.session.error(`Integer schema with unknown format: '${schema.format}' is not valid`, ['Modeler'], schema);
        }
        break;

      case JsonType.Number:
        switch (schema.format) {
          case undefined:
          case NumberFormat.None:
          case NumberFormat.Double:
            return 'double';
          case NumberFormat.Float:
            return 'float'
          case NumberFormat.Decimal:
            return 'double';

          case IntegerFormat.Int64:
            return 'int64';
          case IntegerFormat.Int32:
            return 'int32';

          default:
            this.session.error(`Number schema with unknown format: '${schema.format}' is not valid`, ['Modeler'], schema);
        }
        break;
      case JsonType.String:
        switch (schema.format) {
          // member should be byte array
          // on wire format should be base64url
          case StringFormat.Base64Url:
            return 'Array<byte> & Encoding.Base64'
          case StringFormat.Byte:
            return 'Array<byte>';

          case StringFormat.Certificate:
            return 'Array<byte> /* certificate */';

          case StringFormat.Binary:
            // represent as a binary
            // wire format is stream of bytes
            // This is actually a different kind of response or request
            // and should not be treated as a trivial 'type'
            return 'binary';

          case StringFormat.Char:
            // a single character
            return 'char';

          case StringFormat.Date:
            return 'date';

          case StringFormat.Time:
            return 'time';

          case StringFormat.DateTime:
            return 'datetime';

          case StringFormat.DateTimeRfc1123:
            return `datetimeRfc1123`;

          case StringFormat.Duration:
            return 'duration'

          case StringFormat.Uuid:
            return 'uuid';

          case StringFormat.Url:
            return 'url';

          case StringFormat.Password:
            return 'password';

          case StringFormat.OData:
            return 'string /*odata?*/';

          case StringFormat.None:
          case undefined:
          case null:
            return 'string';

          default:
            // console.error(`String schema '${name}' with unknown format: '${schema.format}' is treated as simple string.`);
            return `string /* ${schema.format} */`;

        }
    }

    return 'unknown';
  }

  createEnum(schema: OpenAPI.Schema) {
    if (schema.enum) {

      const enumName = schema['x-ms-metadata'] ? pascalCase(schema['x-ms-metadata'].name) : "unknown";
      const file = this.createFile(schema);

      const e = file.addEnum({
        name: enumName, isExported: true, docs: docDescription(schema.description),
        members: schema['x-ms-enum'] && schema['x-ms-enum'].values ? schema['x-ms-enum'].values.map((each: any) => ({
          docs: docDescription(each.description),
          name: quoteForIdentifier(getValidEnumValueName(`${(each.name !== undefined) ? each.name : each.value}`)),
          value: each.value
        })) :
          schema.enum.map(each => ({
            name: quoteForIdentifier(getValidEnumValueName(each)),
            value: each
          }))
      });
      this.processed.set(schema, e);

      if (schema.deprecated) {
        e.addJsDoc('\n@deprecated');
      }
      return e;
    }
    throw Error(`Enum failed ${JSON.stringify(schema, undefined, 2)}`);
  }

  createOperationClass(name: string) {
    const filename = `${name}.ts`;
    const file = this.operations.getSourceFile(filename) || this.operations.createSourceFile(filename);

    return file.getClass(name) || file.addClass({ name, isExported: true });
  }

  createOperation(method: string, operation: OpenAPI.HttpOperation, metadata: any) {
    let [path, query] = (<string>metadata.path).split('?', 2);
    let name = '';
    let group = ''

    // try to get a class name and operation name
    if (operation.operationId) {
      [group, name] = operation.operationId.split('_', 2);
      if (!name) {
        name = group;
        group = 'Service';
      }
    } else {
      group = 'Service';
      name = path.replace(/\{.*?\}/g, '').replace(/\/+$/g, '').replace(/^.*\//, '');
      if (!name && operation.tags) {
        name = operation.tags[0];
      }
      if (!name) {
        name = `Operation${this.op++}`;
      }
    }

    const oc = this.createOperationClass(group);
    const m = oc.addProperty({
      name: name,
      type: `() => unknown`,

      docs: docDescription(operation.description),
      // decorators: [{ name: `Http${pascalCase(method)}` }, { name: 'Path', arguments: [`'${path}'`] }]
    });


    // parameters:
    const [required, optional] = this.deref(operation.parameters).bifurcate(each => !!each.required);

    // find path parameters, order them in the order they are in the path
    const p = new Array<string>();
    for (let each, rx = /\{(.*?)\}/g; each = rx.exec(path);) {
      p.push(each[1]);
    }
    for (const each of p.reverse()) {
      const i = required.findIndex(item => item.name === each);
      if (i != -1) {
        required.unshift(required.splice(i, 1)[0]);
      }
    }


    const getDef = (params: OpenAPI.Parameter[]) => params.map(parameter => {
      if (!parameter.schema) {
        return ``;
      }

      const t = this.addImportFor(oc.getSourceFile(), this.acquireTypeForSchema(dereference(this.model, parameter.schema).instance)).getName();
      let p = camelCase(parameter.name);
      if (p === 'default') {
        p = "$default";
      }

      m.addJsDoc({ description: `\n@parameter ${p} - ${parameter.description}` });
      switch (parameter.in) {
        case OpenAPI.ParameterLocation.Cookie:
          return p !== parameter.name ?
            `${p}${parameter.required ? '' : '?'}: Http.Cookie<${t},'${parameter.name}'>` :
            `${p}${parameter.required ? '' : '?'}: Http.Cookie<${t}>`;

        case OpenAPI.ParameterLocation.Path:
          return p !== parameter.name ? `${p}: Http.Path<${t},'${parameter.name}'>` :
            `${p}:${t}`;

        case OpenAPI.ParameterLocation.Header:
          return p !== parameter.name ? `${p}${parameter.required ? '' : '?'}: Http.Header<${t}, '${parameter.name}'>` :
            `${p}${parameter.required ? '' : '?'}: Http.Header<${t}>`;

        case OpenAPI.ParameterLocation.Query:
          return p !== parameter.name ? `${p}${parameter.required ? '' : '?'}: Http.Query<${t},'${parameter.name}'>` :
            `${p}${parameter.required ? '' : '?'}: Http.Query<${t}>`;
      }
      return ``;
    });

    const params = getDef(required);

    let requestBody = '';

    if (operation.requestBody) {
      const rb = dereference(this.model, operation.requestBody).instance;
      const tt = items(rb.content).first();
      if (tt) {
        if (tt.value.schema) {
          const schema = dereference(this.model, tt.value.schema).instance;
          const t = this.addImportFor(oc.getSourceFile(), this.acquireTypeForSchema(schema)).getName();
          params.push(`${rb['x-ms-requestBody-name'] || 'body'}: Http.Body<${t},'${tt.key}'>`);
          m.addJsDoc({ description: `\n@parameter ${rb['x-ms-requestBody-name'] || 'body'} - ${schema.description}` })
        } else {
          // no request body? 
        }
      }
    }
    params.push(...getDef(optional));

    m.addJsDoc({ description: `\n@http ${method.toUpperCase()} ${path}` });

    /// const params = requestBody ? [...getDef(required), requestBody, ...getDef(optional)] : [...getDef(required), ...getDef(optional)].join(' , ');

    // responses
    const r = new Array<string>();
    for (const { key, value: responses } of this.derefD(operation.responses)) {
      const code = key === 'default' ? 'Http.Default' : key;
      const rt = key === 'default' ? 'Exception' : 'Response'
      if (responses.content) {
        for (const { key: mediatype, value: schema } of this.derefD(responses.content)) {
          if (schema.schema) {
            r.push(`Http.${rt}<${code},${this.addImportFor(oc.getSourceFile(), this.acquireTypeForSchema(dereference(this.model, schema.schema).instance)).getName()},'${mediatype}'>`)
          } else {
            r.push(`Http.${rt}<${code},none,'${mediatype}'>`);
          }
        }
      } else {
        r.push(`Http.${rt}<${code}>`);
      }
    }
    m.set({ type: `(${params.join(' , ')}) => ${r.join('|')}` })
  }

  optimizeFile(sourceFile: SourceFile) {
    // exchange numeric status codes for named status codes.
    // move most common @Path() from operations up to the class level (where it is more than one use)
    // extract common parameters out to the Parameters.ts file
    // exchange constant MediaTypes for named media types (ie, MediaType.ApplicationJson)
    // remove @version comments if all the service api versions are supported.
    // exchange Format<''> literals for named ones

  }

  async processOperations() {
    for (const path of values(this.model.paths)) {
      for (const method of ['get', 'put', 'delete', 'head', 'options', 'patch', 'post', 'trace']) {
        if (path[method]) {
          this.createOperation(method, path[method], path['x-ms-metadata']);
        }
      }

    }
  }

  async process() {

    await this.processSchemas();

    await this.processOperations();

    await this.generateMain();

    for (const each of this.project.getSourceFiles()) {


      each.formatText({
        // baseIndentSize: 2,
        indentSize: 2,
      });

      this.session.writeFile(`./${each.getFilePath()}`,
        each.print().
          // replace(/(import .* from )"(.*?)"\;/g, `$1'$2';`).
          replace(/    /g, '  ').  // two space indent!
          replace(/\*\/\s*\/\*\*\s*/g, ''). // combine doccomments 
          replace(/(\s*)(\* @http )/g, '$1 *$1$2').

          //replace(/\*\/[\s\r\n]*\/\*\*\s*/g, '\n'). // combine doccomments 
          replace(/(\w*): (\(.*?\) => )(.*)/g, '$1: $2\n    $3\n'). // lf/indent responses


          replace(/ \| Http./g, ' |\n    Http.')

        , undefined, 'source-file-adl');
    }
  }

  deref<T>(source?: OpenAPI.Refable<T>[]) {
    return values(source).select(each => dereference(this.model, each).instance)
  }

  derefD<T>(source?: Dictionary<OpenAPI.Refable<T>>) {
    return items(source).select(each => ({
      key: each.key,
      value: dereference(this.model, each.value).instance
    }));
  }


}

function cache(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
  const fn = target[propertyKey];
  target[propertyKey] = (input: any) => {
    if (target.processed.has(input)) {
      return target.processed.get(input);
    }
    const output = fn(input);
    target.processed.set(input, output);
    return output;
  }
}


function fn<T>(active: Array<T>, remaining: Array<T>, result: Array<Array<T>>): Array<Array<T>> {
  if (active.length || remaining.length) {
    if (remaining.length) {
      fn([...active, remaining[0]], remaining.slice(1), result);
      fn(active, remaining.slice(1), result);
    } else {
      result.push(active);
    }
  }
  return result;
}
function and(...items: Array<string>) {
  return items.filter(each => each).join(' & ');
}
function combinations<T>(elements: Array<T>) {
  return fn([], elements, []);
}
function format(f?: string): string {
  return f ? `Format<'${f}'>` : '';
}
function maxItems(f?: number): string {
  return f ? `MaxItems<${f}>` : '';
}
function minItems(f?: number): string {
  return f ? `MinItems<${f}>` : '';
}
function maxLength(f?: number): string {
  return f ? `MaxLength<${f}>` : '';
}
function minLength(f?: number): string {
  return f ? `MinLength<${f}>` : '';
}
function pattern(f?: string): string {
  return f ? `Pattern<'${f.replace(/\\/g, '\\\\')}'>` : '';
}
function maximum(f?: number, exclusive?: boolean): string {
  return f ? exclusive ? `ExclusiveMaximum<${f}>` : `Maximum<${f}>` : '';
}
function minimum(f?: number, exclusive?: boolean): string {
  return f ? exclusive ? `ExclusiveMinimum<${f}>` : `Minimum<${f}>` : '';
}
