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
It also symlinks all the modules to the root-`node_modules`

# Why does it do this (what is the benefit)?
- It allows the automatic installation of sub-modules that are in a `modules`-folder on `npm install`.
- It minimizes the installed dependencies, because all dependencies are installed in the root-`node_modules`
- Because all sub-modules are linked into the root-`node_modules`, they can be required without navigating. Instead of `require('./modules/myModule')` you can just say `require('myModule')`

# How does it do this?
1. Look for a `modules`-folder, and for modules in it
1. Gather the module details from the package.json of every module.
1. Remove all module-symlinks from the root-`node_modules`
1. npm-install all dependencies of all modules into the root-`node_modules`
1. Run the postinstall-commands of the modules by doing the following for every module:
    1. check, if a postinstall command exists. if not, continue with the next module
    1. create a symlink in the module-folder that points to the root-`node_modules`
    1. run the postinstall-command
    1. remove the previously created symlink.
1. create symlinks in the root-`node_modules` that point to the module-folders

# Why are certain things done the way they are?
- step 2: this is done, so that the following npm-install wouldn't try to recursively install things within `node_modules`
- step 5.2: this is done, so that possible npm-installs done by the postinstall end up in the root-`node_modules`, and any possible dependencies needed by the postinstall are avaliable to it
- step 6: this is done, so that the modules can be required without navigating to it in the require-statement

# Known issues
At the moment, whenever two or more local modules depend on the same package, but with different, incompatible versions, minstall will exit with an error that tells you, where the incompatibility occured.

If you absolutely have to use incompatible versions of the same package throughout your project, minstall is __not just yet__ for you.

~~In the (probably near) future, support for multiple versions of the same package will get implemented!~~

__There is an actual plan now, and i've started working on this, see [Issue 5](https://github.com/heikomat/minstall/issues/5).__

# Glossary
##### root-node_modules
The `node_modules`-folder that is in the project-root

##### module
A folder that does not start with a `.`, and that contains a package.json

##### module-details
A collection of the following information about a module:

1. folderName
1. module-name
1. module-dependencies
1. postinstall-command for the module
