/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { AutoRestExtension, } from '@azure-tools/autorest-extension-base';
import { processRequest as openapiToAdl } from './openapi-to-adl';

require('source-map-support').install();

async function main() {
  const pluginHost = new AutoRestExtension();

  pluginHost.Add('adl', openapiToAdl);

  await pluginHost.Run();
}

main();
