import * as Promise from 'bluebird';
import * as fs from 'fs';
import * as path from 'path';

export class ModuleInfo {

  constructor(location, folderName, name, version, dependencies, postinstallCommand, bin) {
    this._location = location;
    this._realFolderName = folderName;
    this._folderName = name;
    this._name = name;
    this._version = version;
    this._dependencies = dependencies;
    this._postinstallCommand = postinstallCommand;
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

  public get location() {
    return this._location;
  }

  public get fullModulePath() {
    return this._fullModulePath;
  }

  // gets the folder-name the module should have according to it's module-name
  public get folderName() {
    return this._folderName;
  }

  // get's the folder-name the module actually has on the disk.
  // This should only differ from folderName for local modules,
  // never for modules within node_modules
  public get realFolderName() {
    return this._realFolderName;
  }

  public get name() {
    return this._name;
  }

  public get version() {
    return this._version;
  }

  public get dependencies() {
    return this._dependencies;
  }

  public get postinstallCommand() {
    return this._postinstallCommand;
  }

  public get isScoped() {
    return this._isScoped;
  }

  public get bin() {
    return this._bin;
  }

  public static loadFromFolder(rootFolder, moduleFolder) {
    return new Promise((resolve, reject) => {
      if (rootFolder === null || rootFolder === undefined) {
        rootFolder = this.modulesFolder;
      }

      const packagePath = path.join(rootFolder, moduleFolder, 'package.json');

      fs.readFile(packagePath, 'utf8', (error, data) => {
        if (error) {
          return reject(error);
        }

        let packageInfo;
        try {
          packageInfo = JSON.parse(data);
        } catch (parseError) {
          throw new Error(`couldn't parse package.json at '${packagePath}': ${parseError.message}`);
        }

        const dependencies = packageInfo.dependencies || [];
        if ((!process.env.NODE_ENV || process.env.NODE_ENV !== 'production')
            && packageInfo.devDependencies) {
          for (const dependency in packageInfo.devDependencies) {
            dependencies[dependency] = packageInfo.devDependencies[dependency];
          }
        }

        if (packageInfo.peerDependencies) {
          for (const dependency in packageInfo.peerDependencies) {
            dependencies[dependency] = packageInfo.peerDependencies[dependency];
          }
        }

        let postinstallCommand = null;
        if (packageInfo.scripts && packageInfo.scripts.postinstall) {
          postinstallCommand = packageInfo.scripts.postinstall;
        }

        return resolve(new ModuleInfo(rootFolder, moduleFolder, packageInfo.name,
                                      packageInfo.version, dependencies, postinstallCommand, packageInfo.bin));
      });
    });
  }

}
