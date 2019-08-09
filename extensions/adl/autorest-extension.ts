/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { AutoRestExtension, } from '@microsoft.azure/autorest-extension-base';

require('source-map-support').install();

async function main() {
  const pluginHost = new AutoRestExtension();


  await pluginHost.Run();
}

main();
