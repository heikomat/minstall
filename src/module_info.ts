/* eslint-disable @typescript-eslint/member-naming */
import * as fs from 'fs';
import * as path from 'path';

export interface DependencyEntries {
  [dependency: string]: string;
}

export interface BinEntry {
  [dependency: string]: string;
}

export interface PackageJson {
  name: string;
  version: string;
  dependencies?: DependencyEntries;
  devDependencies?: DependencyEntries;
  peerDependencies?: DependencyEntries;
  scripts: {
    [scriptName: string]: string;
  };
  bin: string | BinEntry;
}

export class ModuleInfo {

  private _location: string;
  private _realFolderName: string;
  private _folderName: string;
  private _name: string;
  private _version: string;
  private _dependencies: DependencyEntries;
  private _postinstallCommand: string;
  private _isScoped = false;
  private _fullModulePath: string;
  private _bin: {[name: string]: string};

  constructor(
    location: string,
    folderName: string,
    name: string,
    version: string,
    dependencies: DependencyEntries,
    postinstallCommand: string,
    bin: string | BinEntry,
  ) {

    this._location = location;
    this._realFolderName = folderName;
    this._folderName = name;
    this._name = name;
    this._version = version;
    this._dependencies = dependencies;
    this._postinstallCommand = postinstallCommand;
    this._isScoped = false;
    this._fullModulePath = path.join(this.location, this.realFolderName);

    if (bin === undefined || bin === null) {
      this._bin = {};
    } else if (typeof bin === 'string') {
      this._bin = {
        [name]: bin,
      };
    } else {
      this._bin = bin;
    }

    if (name.charAt(0) === '@') {
      const moduleNameParts: Array<string> = name.split('/');
      this._folderName = path.join(moduleNameParts[0], moduleNameParts[1]);
      this._isScoped = true;
    }
  }

  public get location(): string {
    return this._location;
  }

  public get fullModulePath(): string {
    return this._fullModulePath;
  }

  // gets the folder-name the module should have according to it's module-name
  public get folderName(): string {
    return this._folderName;
  }

  // get's the folder-name the module actually has on the disk.
  // This should only differ from folderName for local modules,
  // never for modules within node_modules
  public get realFolderName(): string {
    return this._realFolderName;
  }

  public get name(): string {
    return this._name;
  }

  public get version(): string {
    return this._version;
  }

  public get dependencies(): DependencyEntries {
    return this._dependencies;
  }

  public get postinstallCommand(): string {
    return this._postinstallCommand;
  }

  public get isScoped(): boolean {
    return this._isScoped;
  }

  public get bin(): BinEntry {
    return this._bin;
  }

  public static loadFromFolder(rootFolder: string, moduleFolder: string): Promise<ModuleInfo> {
    return new Promise((resolve: Function, reject: Function): void => {
      const packagePath: string = path.join(rootFolder, moduleFolder, 'package.json');

      fs.readFile(packagePath, 'utf8', (error: Error, data: string) => {
        if (error) {
          return reject(error);
        }

        let packageInfo: PackageJson;
        try {
          packageInfo = JSON.parse(data);
        } catch (parseError) {
          throw new Error(`couldn't parse package.json at '${packagePath}': ${parseError.message}`);
        }

        const dependencies: DependencyEntries = packageInfo.dependencies || {};
        if ((!process.env.NODE_ENV || process.env.NODE_ENV !== 'production')
            && packageInfo.devDependencies) {
          for (const [dependency, version] of Object.entries(packageInfo.devDependencies)) {
            dependencies[dependency] = version;
          }
        }

        if (packageInfo.peerDependencies) {
          for (const [dependency, version] of Object.entries(packageInfo.peerDependencies)) {
            dependencies[dependency] = version;
          }
        }

        let postinstallCommand: string = null;
        if (packageInfo.scripts && packageInfo.scripts.postinstall) {
          postinstallCommand = packageInfo.scripts.postinstall;
        }

        return resolve(new ModuleInfo(
          rootFolder, moduleFolder, packageInfo.name,
          packageInfo.version, dependencies, postinstallCommand, packageInfo.bin,
        ));
      });
    });
  }

}
