import * as fs from 'fs';
import * as path from 'path';
import * as semver from 'semver';
import {Winston} from 'winston';
import {DependencyRequestInfo, ModulesAndDependenciesInfo} from './interfaces';
import {ModuleInfo} from './module_info';
import {SystemTools} from './systools';

let logger: Winston = null;

export class ModuleTools {

  public static modulesFolder: string = 'modules';
  public static nullTarget: string = '/dev/null';
  public static commandConcatSymbol: string = ';';

  public static setModulesFolder(modulesFolder: string): void {
    this.modulesFolder = modulesFolder;
  }

  public static setNullTarget(nullTarget: string): void {
    this.nullTarget = nullTarget;
  }

  public static setCommandConcatSymbol(commandConcatSymbol: string): void {
    this.commandConcatSymbol = commandConcatSymbol;
  }

  public static setLogger(_logger: Winston): void {
    logger = _logger;
  }

  public static logVerbose(): boolean {
    return ['verbose', 'debug', 'silly'].indexOf(logger.level) >= 0;
  }

  public static async getAllModulesAndInstalledDependenciesDeep(location?: string, folderName?: string): Promise<ModulesAndDependenciesInfo> {
    if (location === null || location === undefined) {
      location = process.cwd();
    }

    if (folderName === null || folderName === undefined) {
      folderName = this.modulesFolder;
    }

    const result: ModulesAndDependenciesInfo = {
      modules: [],
      installedDependencies: [],
    };

    // get the local modules and the installed modules within the current path
    const [
      currentModuleInfo,
      installedModulesInfo,
      localSubmodulesInfo,
    ] = await Promise.all([
      ModuleInfo.loadFromFolder(location, ''),    // get infos about the current module
      this.getModules(location, 'node_modules'),  // get infos about installed modules in the current module
      this.getModules(location, folderName),      // get infos about local submodules of the current module
    ]);

    result.modules.push(currentModuleInfo);
    result.installedDependencies = result.installedDependencies.concat(installedModulesInfo);

    // recursively get the local modules and installed dependencies of all the other local modules
    const otherLevelModules: Array<typeof result> = await Promise.all(localSubmodulesInfo.map((module: ModuleInfo) => {
      return this.getAllModulesAndInstalledDependenciesDeep(module.fullModulePath, folderName);
    }));

    for (const moduleAndDependencyInfo of otherLevelModules) {

      result.modules = result.modules.concat(moduleAndDependencyInfo.modules)
        .filter((module: ModuleInfo) => {
          return module !== null;
        });

      result.installedDependencies = result.installedDependencies.concat(moduleAndDependencyInfo.installedDependencies)
        .filter((module: ModuleInfo) => {
          return module !== null;
        });
    }

    return result;
  }

  public static async getModules(location: string, rootFolder: string): Promise<Array<ModuleInfo>> {
    const result: Array<ModuleInfo> = [];

    if (rootFolder === null || rootFolder === undefined) {
      rootFolder = this.modulesFolder;
    }
    const modulesPath: string = path.join(location, rootFolder);
    const folderNames: Array<string> = await SystemTools.getFolderNames(modulesPath);

    const scopedFolder: Array<string> = folderNames.filter((folderName: string) => {
      return folderName.indexOf('@') === 0;
    });

    const moduleNames: Array<string> = await Promise.all(folderNames.map((folderName: string) => {
      return this.verifyModule(modulesPath, folderName);
    }));

    const modules: Array<string> = moduleNames.filter((moduleName: string) => {
      return moduleName !== null;
    });

    // we can't open too many files at once :( read them sequentially
    for (const moduleName of modules) {
      const module: ModuleInfo = await ModuleInfo.loadFromFolder(path.join(location, rootFolder), moduleName);
      result.push(module);
    }

    let scopedModules: Array<Array<ModuleInfo>> = [];
    if (scopedFolder.length > 0) {
      scopedModules = await Promise.all(scopedFolder.map((folderName: string) => {
        return this.getModules(path.join(location, rootFolder), folderName);
      }));
    }

    return result.concat([].concat(...scopedModules));
  }

  public static verifyModule(location: string, name: string): Promise<string> {
    return new Promise((resolve: Function, reject: Function): void => {

      // the constant is called fs.F_OK in node < 6, and fs.constants.F_OK in node >= 6
      // tslint:disable-next-line:no-any
      let mode: number = (<any> fs).F_OK;
      if (fs.constants) {
        mode = fs.constants.F_OK;
      }

      fs.access(path.join(location, name, 'package.json'), mode, (error: Error) => {
        if (error) {
          // folder has no package.json, thus it is not a module
          return resolve(null);
        }

        return resolve(name);
      });
    });
  }

  public static async installPackets(targetFolder: string, packets: Array<DependencyRequestInfo>): Promise<void> {

    if (packets.length === 0) {
      return Promise.resolve();
    }

    const identifier: Array<string> = packets.map((packet: DependencyRequestInfo) => {
      return packet.identifier;
    });

    let npmiLoglevel: string = 'error';
    let nullTarget: string = ` > ${this.nullTarget}`;
    if (this.logVerbose()) {
      npmiLoglevel = 'info';
      nullTarget = '';
    }

    try {
      // tslint:disable-next-line:max-line-length
      await SystemTools.runCommand(`cd ${targetFolder}${this.commandConcatSymbol} npm install --no-save --no-package-lock --loglevel ${npmiLoglevel} ${identifier.join(' ')}${nullTarget}`);
    } catch (error) {
      // npm pushes all its info- and wanr-logs to stderr. If we have a debug
      // flag set, and we wouldn't catch here, then minstall would fail
      // although the installation was successful.
      // npm however only exits with an error-code if actual errors happened.
      // because of this, minstall should fail if an errorcode > 0 exists
      if (error.code !== undefined && error.code !== null && error.code > 0) {
        process.exit(1);
      }

      // If no error-code exists, then this is just info-stuff that npm pushes
      // to stderr, so we reroute it to stdout instead of throwing an error
      process.stdout.write(error.message);
    }
  }
}
