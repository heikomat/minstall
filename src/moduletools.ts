import * as fs from 'fs';
import * as path from 'path';
import * as semver from 'semver';
import {ModuleInfo} from './module_info';
import {systools} from './systools';

let logger = null;

export const moduletools = {

  modulesFolder: 'modules',
  nullTarget: '/dev/null',
  commandConcatSymbol: ';',

  setModulesFolder(modulesFolder) {
    this.modulesFolder = modulesFolder;
  },

  setNullTarget(nullTarget) {
    this.nullTarget = nullTarget;
  },

  setCommandConcatSymbol(commandConcatSymbol) {
    this.commandConcatSymbol = commandConcatSymbol;
  },

  setLogger(_logger) {
    logger = _logger;
  },

  logVerbose() {
    return ['verbose', 'debug', 'silly'].indexOf(logger.level) >= 0;
  },

  async getAllModulesAndInstalledDependenciesDeep(location?, folderName?) {
    if (location === null || location === undefined) {
      location = process.cwd();
    }

    if (folderName === null || folderName === undefined) {
      folderName = this.modulesFolder;
    }

    const result = {
      modules: [],
      installedDependencies: [],
    };

    // get the local modules and the installed modules within the current path
    const currentLevelModules = await Promise.all([
      ModuleInfo.loadFromFolder(location, ''),    // get infos about the current module
      this.getModules(location, 'node_modules'),  // get infos about installed modules in the current module
      this.getModules(location, folderName),      // get infos about local submodules of the current module
    ]);

    result.modules.push(currentLevelModules[0]);
    result.installedDependencies = result.installedDependencies.concat(currentLevelModules[1]);

    // recursively get the local modules and installed dependencies of all the other local modules
    const otherLevelModules: Array<any> = await Promise.all(currentLevelModules[2].map((module) => {
      return this.getAllModulesAndInstalledDependenciesDeep(module.fullModulePath, folderName);
    }));

    for (const moduleAndDependencyInfo of otherLevelModules) {

      result.modules = result.modules.concat(moduleAndDependencyInfo.modules)
        .filter((module) => {
          return module !== null;
        });

      result.installedDependencies = result.installedDependencies.concat(moduleAndDependencyInfo.installedDependencies)
        .filter((module) => {
          return module !== null;
        });
    }

    return result;
  },

  async getModules(location, rootFolder) {
    let scopedFolder = [];
    const result = [];

    if (rootFolder === null || rootFolder === undefined) {
      rootFolder = this.modulesFolder;
    }
    const modulesPath = path.join(location, rootFolder);
    const folderNames = await systools.getFolderNames(modulesPath);

    scopedFolder = folderNames.filter((folderName) => {
      return folderName.indexOf('@') === 0;
    });

    const moduleNames = await Promise.all(folderNames.map((folderName) => {
      return this.verifyModule(modulesPath, folderName);
    }));

    const modules = moduleNames.filter((moduleName) => {
      return moduleName !== null;
    });

    // we can't open too many files at once :( read them sequentially
    const moduleInfos = [];
    for (const moduleName of modules) {
      const module = await ModuleInfo.loadFromFolder(path.join(location, rootFolder), moduleName);
      moduleInfos.push(module);
    }

    if (scopedFolder.length === 0) {
      return [];
    }

    const scopedModules = await Promise.all(scopedFolder.map((folderName) => {
      return this.getModules(path.join(location, rootFolder), folderName);
    }));

    return result.concat([].concat.apply([], scopedModules));
  },

  verifyModule(location, name) {
    return new Promise((resolve, reject) => {

      // the constant is called fs.F_OK in node < 6, and fs.constants.F_OK in node >= 6
      let mode = (<any> fs).F_OK;
      if (fs.constants) {
        mode = fs.constants.F_OK;
      }

      fs.access(path.join(location, name, 'package.json'), mode, (error) => {
        if (error) {
          // folder has no package.json, thus it is not a module
          return resolve(null);
        }

        return resolve(name);
      });
    });
  },

  async installPackets(targetFolder, packets) {

    if (packets.length === 0) {
      return Promise.resolve();
    }

    const identifier = packets.map((packet) => {
      return packet.identifier;
    });

    let npmiLoglevel = 'error';
    let nullTarget = ` > ${this.nullTarget}`;
    if (this.logVerbose()) {
      npmiLoglevel = 'info';
      nullTarget = '';
    }

    try {
      return systools.runCommand(`cd ${targetFolder}${this.commandConcatSymbol} npm install --no-save --no-package-lock --loglevel ${npmiLoglevel} ${identifier.join(' ')}${nullTarget}`);
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
  },
};
