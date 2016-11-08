'use strict';

const fs = require('fs');
const path = require('path');
const Promise = require('bluebird');
const systools = require('./systools');
const ModuleInfo = require('./ModuleInfo');
const semver = require('semver');

const InstalledVersionMismatchError = require('./InstalledVersionMismatchError.js');

const moduletools = {

  modulesFolder: 'modules',
  setModulesFolder(modulesFolder) {
    this.modulesFolder = modulesFolder;
  },

  getModules(rootFolder) {
    if (rootFolder === null || rootFolder === undefined) {
      rootFolder = this.modulesFolder;
    }
    const modulesPath = path.join(process.cwd(), rootFolder);

    return systools.getFolderNames(modulesPath)
      .then((folderNames) => {
        return Promise.all(folderNames.map((folderName) => {
          return this.verifyModule(modulesPath, folderName);
        }));
      })
      .then((moduleNames) => {
        const modules = moduleNames.filter((moduleName) => {
          return moduleName != null;
        });

        return Promise.all(modules.map((moduleName) => {
          return ModuleInfo.loadFromFolder(rootFolder, moduleName);
        }));
      });
  },

  logModules(moduleInfos) {
    const moduleNames = moduleInfos.map((moduleInfo) => {
      let hasPostinstall = 'no  postinstall';
      if (moduleInfo.postinstall) {
        hasPostinstall = 'has postinstall';
      }

      let depsCount = Object.keys(moduleInfo.dependencies).length;
      if (depsCount <= 9) {
        depsCount = `${depsCount} `;
      }
      return `|  ${depsCount} deps  |  ${hasPostinstall}  |  ${moduleInfo.folderName}`;
    });
    console.log(`running minstall. modules found: \n${moduleNames.join('\n')}`);
  },

  getModuleDependencies(installedModules, moduleInfos) {
    const dependencies = [];
    const installingModules = [];
    const installedModuleNames = installedModules.map((module) => {
      return module.name;
    });

    let installedIndex = -1;
    let checkVersion = null;
    let targetRange = null;

    for (let index = 0; index < moduleInfos.length; index += 1) {
      for (let name in moduleInfos[index].dependencies) {
        installedIndex = installedModuleNames.indexOf(name);
        targetRange = moduleInfos[index].dependencies[name];

        if (installedIndex > 0) {
          checkVersion = installedModules[installedIndex].version;
          if (!semver.satisfies(checkVersion, targetRange)) {
            throw new InstalledVersionMismatchError('', moduleInfos[index].name, name, checkVersion, targetRange);
          }
        }

        if (installedModuleNames.indexOf(name) < 0 && installingModules.indexOf(name) < 0) {
          dependencies.push(`${name}@"${moduleInfos[index].dependencies[name]}"`);
          installingModules.push(name);
        }
      }
    }

    return dependencies;
  },

  verifyModule(location, name) {
    return new Promise((resolve, reject) => {
      let mode = fs.F_OK;
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
};

module.exports = moduletools;
