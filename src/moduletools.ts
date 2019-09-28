import * as fs from 'fs';
import * as path from 'path';
import * as logger from 'winston';
import {DependencyRequestInfo, ModulesAndDependenciesInfo} from './interfaces';
import {ModuleInfo} from './module_info';
import {SystemTools} from './systools';

export const ModuleTools = {

  modulesFolder: 'modules',
  nullTarget: '/dev/null',
  commandConcatSymbol: ';',

  setModulesFolder: (modulesFolder: string): void => {
    this.modulesFolder = modulesFolder;
  },

  setNullTarget: (nullTarget: string): void => {
    this.nullTarget = nullTarget;
  },

  setCommandConcatSymbol: (commandConcatSymbol: string): void => {
    this.commandConcatSymbol = commandConcatSymbol;
  },

  logVerbose: (): boolean => {
    return ['verbose', 'debug', 'silly'].indexOf(logger.level) >= 0;
  },

  getAllModulesAndInstalledDependenciesDeep: async (
    location: string = process.cwd(),
    folderName: string = this.modulesFolder,
  ): Promise<ModulesAndDependenciesInfo> => {
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
      ModuleInfo.loadFromFolder(location, ''), // get infos about the current module
      this.getModules(location, 'node_modules'), // get infos about installed modules in the current module
      this.getModules(location, folderName), // get infos about local submodules of the current module
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
  },

  getModules: async (location: string, rootFolder: string = this.modulesFolder): Promise<Array<ModuleInfo>> => {
    const result: Array<ModuleInfo> = [];

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
  },

  verifyModule: (location: string, name: string): Promise<string> => {
    return new Promise((resolve: Function, reject: Function): void => {
      fs.access(path.join(location, name, 'package.json'), fs.constants.F_OK, (error: Error) => {
        if (error) {
          // folder has no package.json, thus it is not a module
          return resolve(null);
        }

        return resolve(name);
      });
    });
  },

  installPackets: async (targetFolder: string, packets: Array<DependencyRequestInfo>): Promise<void> => {

    if (packets.length === 0) {
      return Promise.resolve();
    }

    const identifier: Array<string> = packets.map((packet: DependencyRequestInfo) => {
      return packet.identifier;
    });

    let npmiLoglevel = 'error';
    let nullTarget = ` > ${this.nullTarget}`;
    if (this.logVerbose()) {
      npmiLoglevel = 'info';
      nullTarget = '';
    }

    try {
      // eslint-disable-next-line max-len
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
    return Promise.resolve();
  },
};
