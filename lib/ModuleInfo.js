'use strict';

const fs = require('fs');
const path = require('path');
const Promise = require('bluebird');

class ModuleInfo {

  constructor(location, folderName, name, version, dependencies, postinstall, bin) {
    this._location = location;
    this._realFolderName = folderName;
    this._folderName = name;
    this._name = name;
    this._version = version;
    this._dependencies = dependencies;
    this._postinstall = postinstall;
    this._isScoped = false;
    this._fullModulePath = path.join(this.location, this.realFolderName);
    this._bin = bin;
    if (this._bin === undefined || this._bin === null) {
      this._bin = {};
    }

    if (typeof this._bin === 'string') {
      this._bin = {
        [name]: bin,
      };
    }

    if (name.charAt(0) === '@') {
      const moduleNameParts = name.split('/');
      this._folderName = path.join(moduleNameParts[0], moduleNameParts[1]);
      this._isScoped = true;
    }
  }

  get location() {
    return this._location;
  }

  get fullModulePath() {
    return this._fullModulePath;
  }

  // gets the folder-name the module should have according to it's module-name
  get folderName() {
    return this._folderName;
  }

  // get's the folder-name the module actually has on the disk.
  // This should only differ from folderName for local modules,
  // never for modules within node_modules
  get realFolderName() {
    return this._realFolderName;
  }

  get name() {
    return this._name;
  }

  get version() {
    return this._version;
  }

  get dependencies() {
    return this._dependencies;
  }

  get postinstall() {
    return this._postinstall;
  }

  get isScoped() {
    return this._isScoped;
  }

  get bin() {
    return this._bin;
  }

  static loadFromFolder(rootFolder, moduleFolder) {
    return new Promise((resolve, reject) => {
      if (rootFolder === null || rootFolder === undefined) {
        rootFolder = this.modulesFolder;
      }

      const packagePath = path.join(rootFolder, moduleFolder, 'package.json');

      fs.readFile(packagePath, 'utf8', (error, data) => {
        if (error) {
          return reject(error);
        }

        const packageInfo = JSON.parse(data);
        const dependencies = packageInfo.dependencies || [];
        if ((!process.env.NODE_ENV || process.env.NODE_ENV !== 'production')
            && packageInfo.devDependencies) {
          for (const dependency in packageInfo.devDependencies) {
            dependencies[dependency] = packageInfo.devDependencies[dependency];
          }
        }
        let postinstall = null;
        if (packageInfo.scripts && packageInfo.scripts.postinstall) {
          postinstall = packageInfo.scripts.postinstall;
        }

        return resolve(new ModuleInfo(rootFolder, moduleFolder, packageInfo.name,
                                      packageInfo.version, dependencies, postinstall, packageInfo.bin));
      });
    });
  }

}

module.exports = ModuleInfo;
