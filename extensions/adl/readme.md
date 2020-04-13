
# Contributing

This project welcomes contributions and suggestions.  Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit https://cla.microsoft.com.

When you submit a pull request, a CLA-bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., label, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.


# Pipeline Configuration
``` yaml !$(enable-deduplication)
# By default, modeler-four based generators will not use the deduplicator or subset reducer
# if we need to easily disable this set the enable-deduplication flag.
pass-thru:
  - model-deduplicator
  - subset-reducer
```


``` yaml
pipeline-model: v3

pipeline:
  adl:
    input: openapi-document/multi-api/identity

  adl/text-transform:
    input: adl
    scope: scope-here

  adl/emitter:
    input: text-transform
    scope: scope-here
    output-artifact: source-file-adl  

scope-here:
  is-object: false
  output-artifact:
    - source-file-adl

output-artifact:
  - source-file-adl
  
```