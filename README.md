# minstall

## In collaboration with
![5Minds IT-Solutions](img/5minds_logo.png "5Minds IT-Solutions")
#### [5minds.de](https://5minds.de)
#### [github.com/5minds](https://github.com/5minds)

# Usage
install with `npm install minstall --save` and add minstall as postinstall-script, by adding it to your package.json like this:
```JavaScript
{
  "scripts": {
    "postinstall": "minstall <modules-folder>"
  }
}
```
`modules-folder` is optional and will default to `modules` if omitted

# What does it do?
It installs dependencies of all modules (and possibly these of submodules of submodules etc.) into the root-`node_modules`.
It also symlinks all the modules to the root-`node_modules`.

__It handles conflicting dependencies correctly__, so that if a local module has dependency of a package, that has been installed by another module in an incompatible version, minstall will add a node_modules-folder for that one module, that will only contain the conflicting version of the dependency. It will also give you a hint, that you might want to try to use the same version throughout the whole project.


# Why does it do this (what is the benefit)?
- It allows the automatic installation of sub-modules that are in a `modules`-folder on `npm install`.
- It minimizes the installed dependencies, because all dependencies are installed in the root-`node_modules`
- Because all sub-modules are linked into the root-`node_modules`, they can be required without navigating. Instead of `require('./modules/myModule')` you can just say `require('myModule')`

# How does it do this?
1. Look for a `modules`-folder, and for modules in it
1. Gather the module details from the package.json of every module.
1. Remove all module-symlinks from the root-`node_modules`
1. check, what dependencies are missing, and what dependencies are conflicting with packages already installed in the root-node_modules
1. check, if some (or all) of the conflicting dependencies are already installed in a possibly existing module-node_modules-folder
1. if conflicting dependencies exist:
    1. create a new folder in the root-node_modules with the name `module.folderName + '_cache'`
    1. move all the already installed packages that are in the root-node_modules and would conflict with the module-dependencies into that cache-folder
1. if in step 5 fitting packages were found, move them to the root-node_modules (this is only to speed up things, so less packages need to be installed)
1. if one exists, delete the module-node_modules folder
1. now that there is no longer a conflicting package in the root-node_modules, install all the missing dependencies to the root-node_modules
1. if the module has a postinstall-script:
    1. create a symlink in the module-folder, that points to the root-node_modules
    1. now that a node_modules-folder with all the fitting dependencies is in the module-folder, run the postinstall-script
    1. delete the previously created symlink
1.  if in step 4, conflicting dependencies were found:
    1. create a node_modules-folder in the module-folder
    1. move all the packages from the root-node_modules-folder that would have caused conflicts to the newly created module-node_modules-folder
    1. move all the cached packages from step 6.2 (those in `module.folderName + '_cache'` in the root-node_modules) out of that folder, to their original place in the root-node_modules
    1. delete the `module.folderName + '_cache'`-folder created in step 6.1 from the root-node_modules
1. create a symlink in the root-node_modules that points to the module
1. update the list of installed packages
1. start over at step 4 with the next module until all modules are installed

# Why are certain things done the way they are?
- step 3: this is done, so that the following npm-install wouldn't try to recursively install things within `node_modules`
- step 10.1: this is done, so that possible npm-installs done by the postinstall end up in the root-`node_modules`, and any possible dependencies needed by the postinstall are avaliable to it
- step 12: this is done, so that the modules can be required without navigating to it in the require-statement

# Known issues
none

# Glossary
##### root-node_modules
The `node_modules`-folder that is in the project-root

##### module-node_modules
The `node_modules`-folder that is in the local module that is currently beeing installed

##### module
A folder that does not start with a `.`, and that contains a package.json

##### module-details
A collection of the following information about a module:

1. folderName
1. module-name
1. module-version
1. module-dependencies
1. postinstall-command for the module
