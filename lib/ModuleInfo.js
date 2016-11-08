'use strict';


const fs = require('fs');
const path = require('path');
const Promise = require('bluebird');

class ModuleInfo {

  constructor(folderName, name, version, dependencies, postinstall) {
    this._folderName = folderName;
    this._name = name;
    this._version = version;
    this._dependencies = dependencies;
    this._postinstall = postinstall;
  }

  get folderName() {
    return this._folderName;
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

  static loadFromFolder(rootFolder, moduleFolder) {
    return new Promise((resolve, reject) => {
      if (rootFolder === null || rootFolder === undefined) {
        rootFolder = this.modulesFolder;
      }

      const packagePath = path.join(process.cwd(), rootFolder, moduleFolder, 'package.json');

      fs.readFile(packagePath, 'utf8', (error, data) => {
        if (error) {
          return reject(error);
        }

        const packageInfo = JSON.parse(data);
        const dependencies = packageInfo.dependencies || [];
        if ((!process.env.NODE_ENV || process.env.NODE_ENV !== 'production')
            && packageInfo.devDependencies) {
          for (let dependency in packageInfo.devDependencies) {
            dependencies[dependency] = packageInfo.devDependencies[dependency];
          }
        }
        let postinstall = null;
        if (packageInfo.scripts && packageInfo.scripts.postinstall) {
          postinstall = packageInfo.scripts.postinstall;
        }

        return resolve(new ModuleInfo(moduleFolder, packageInfo.name,
                                      packageInfo.version, dependencies, postinstall));
      });
    });
  }

}

module.exports = ModuleInfo;
