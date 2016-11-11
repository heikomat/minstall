#!/usr/bin/env node

'use strict';

const os = require('os');
const path = require('path');
const Promise = require('bluebird');
const readline = require('readline');

const UncriticalError = require('./UncriticalError.js');
const systools = require('./systools.js');
const moduletools = require('./moduletools.js');
const ModuleInfo = require('./ModuleInfo');

let commandConcatSymbol = ';';
let isInProjectRoot = true;

function logIfInRoot(message) {
  if (isInProjectRoot) {
    console.log(message);
  }
}

function logVersionConflict(messages, moduleFolderName) {

  const moduleFolder = path.join(process.cwd(), moduletools.modulesFolder, moduleFolderName);
  console.log(`

| UNCRITICAL DEPENDENCY-CONFLICTS FOUND:
|   ${messages.join('\n|   ')}
| 
| This is not an error, but consider using compatible package-versions
| throughout the whole project.`);
}

function getLocalPackageInfo() {
  return ModuleInfo.loadFromFolder('', '');
}

function getInstalledModules() {
  return moduletools.getModules('node_modules');
}

function checkStartConditions() {
  return systools.verifyFolderName(process.cwd(), 'node_modules')
    .then((folderName) => {
      if (folderName == null) {
        throw new UncriticalError('minstall started from outside the project-root. aborting.');
      }

      return systools.verifyFolderName(process.cwd(), moduletools.modulesFolder);
    })
    .then((folderName) => {
      if (folderName == null) {
        throw new UncriticalError(`${moduletools.modulesFolder} not found, thus minstall is done :)`);
      }

      return Promise.all([
        systools.isSymlink(path.join(process.cwd(), 'node_modules')),
        getLocalPackageInfo(),
      ]);
    })
    .then((results) => {
      if (isInProjectRoot) {
        isInProjectRoot = !results[0];
      }

      if (isInProjectRoot && !results[1].dependencies.minstall) {
        throw new UncriticalError('minstall started from outside the project-root. aborting.');
      }
    });
}

function linkModuleToRoot(moduleFolder) {
  const targetPath = path.join(process.cwd(), 'node_modules', moduleFolder);
  const modulePath = path.join(process.cwd(), moduletools.modulesFolder, moduleFolder);
  return systools.link(modulePath, targetPath);
}

function linkRootToModule(moduleFolder) {
  const rootModuleFolder = path.join(process.cwd(), 'node_modules');
  const targetFolder = path.join(process.cwd(), moduletools.modulesFolder, moduleFolder, 'node_modules');
  return systools.link(rootModuleFolder, targetFolder);
}

function installMissingModuleDependencies(moduleFolder, missingDependencies) {
  const moduleNodeModules = path.join(process.cwd(), moduletools.modulesFolder, moduleFolder, 'node_modules');
  return systools.delete(moduleNodeModules)
    .then(() => {
      return moduletools.installPackets(missingDependencies);
    });
}

function runPostinstall(moduleInfo) {
  if (!moduleInfo.postinstall) {
    return Promise.resolve();
  }

  const modulePath = path.join(process.cwd(), moduletools.modulesFolder, moduleInfo.folderName);
  return linkRootToModule(moduleInfo.folderName)
    .then(() => {

      let command = moduleInfo.postinstall;
      if (command.indexOf('minstall') == 0) {
        command += ' isChildProcess'
      }
      return systools.runCommand(`cd ${modulePath}${commandConcatSymbol} ${command}`);
    })
    .then(() => {

      return systools.delete(path.join(modulePath, 'node_modules'));
    });
}

function cacheConflictingModules(conflictedDependencies, moduleFolderName) {

  if (conflictedDependencies.length === 0) {
    return Promise.resolve();
  }

  const conflictedDependencyFolders = conflictedDependencies.map((dependency) => {
    return dependency.folderName;
  });

  const rootNodeModules = path.join(process.cwd(), 'node_modules');
  const cacheFolder = path.join(rootNodeModules, `${moduleFolderName}_cache`);
  return systools.moveMultiple(conflictedDependencyFolders, rootNodeModules, cacheFolder);
}

function uncacheConflictingModules(conflictedDependencies, moduleFolderName) {

  if (conflictedDependencies.length === 0) {
    return Promise.resolve();
  }

  const conflictedDependencyFolders = conflictedDependencies.map((dependency) => {
    return dependency.folderName;
  });

  const rootNodeModules = path.join(process.cwd(), 'node_modules');
  const cacheFolder = path.join(rootNodeModules, `${moduleFolderName}_cache`);
  const moduleFolder = path.join(process.cwd(), moduletools.modulesFolder, moduleFolderName);
  const moduleNodeModules = path.join(moduleFolder, 'node_modules');

  return systools.moveMultiple(conflictedDependencyFolders, rootNodeModules, moduleNodeModules)
    .then(() => {

      return systools.moveMultiple(conflictedDependencyFolders, cacheFolder, rootNodeModules);
    })
    .then(() => {

      return systools.delete(path.join(cacheFolder));
    });
}

function persistExistingConfilctingDependencies(packetsToKeep, moduleFolderName) {

  const packetFolderNames = packetsToKeep.map((packet) => {
    return packet.folderName;
  });

  const rootNodeModules = path.join(process.cwd(), 'node_modules');
  const moduleNodeModules = path.join(process.cwd(), moduletools.modulesFolder, moduleFolderName, 'node_modules');
  return systools.moveMultiple(packetFolderNames, moduleNodeModules, rootNodeModules);
}

function installModules(installedModules, moduleInfos, index) {

  const moduleIndex = index || 0;
  if (moduleIndex >= moduleInfos.length) {
    return Promise.resolve();
  }

  if (moduleIndex > 0 && isInProjectRoot) {
    readline.clearLine(process.stdout);
    readline.cursorTo(process.stdout, 0);
  }

  const moduleInfo = moduleInfos[moduleIndex];
  if (isInProjectRoot) {
    let moduleNumber = moduleIndex + 1
    if (moduleInfos.length > 9 && moduleNumber <= 9) {
      moduleNumber = `0${moduleNumber}`;
    }
    process.stdout.write(`installing module ${moduleNumber}/${moduleInfos.length} -> ${moduleInfo.folderName} `);
  }

  let packetsToKeep;
  const deps = moduletools.getModuleDependencies(installedModules, moduleInfo);
  if (deps.messages.length > 0) {
    logVersionConflict(deps.messages, moduleInfo.folderName);
  }

  return moduletools.getPreinstalledPacketsEvaluation(moduleInfo.folderName, deps.missing)
    .then((result) => {
      packetsToKeep = result.keep;
      deps.missing = result.missing;
      return cacheConflictingModules(deps.conflicted, moduleInfo.folderName);
    })
    .then(() => {
      return persistExistingConfilctingDependencies(packetsToKeep, moduleInfo.folderName);
    })
    .then(() => {
      return installMissingModuleDependencies(moduleInfo.folderName, deps.missing);
    })
    .then(() => {
      return runPostinstall(moduleInfo);
    })
    .then(() => {
      return uncacheConflictingModules(deps.conflicted, moduleInfo.folderName);
    })
    .then(() => {
      return linkModuleToRoot(moduleInfo.folderName);
    })
    .then(() => {
      return getInstalledModules();
    })
    .then((modules) => {
      return installModules(modules, moduleInfos, moduleIndex + 1);
    });
}

function run() {
  const startTime = Date.now();
  if (process.argv[2]) {
    moduletools.setModulesFolder(process.argv[2]);
  }

  if (process.argv.indexOf('isChildProcess') >= 0) {
    isInProjectRoot = false;
  };

  if (os.platform() === 'win32') {
    commandConcatSymbol = '&';
    moduletools.setNullTarget('NUL');
  }

  checkStartConditions()
    .then(() => {
      return Promise.all([
        getInstalledModules(),
        moduletools.getModules(),
      ]);
    })
    .then((modules) => {
      const installedModules = modules[0];
      const moduleInfos = modules[1];
      if (moduleInfos.length === 0) {
        throw new UncriticalError('no modules found, thus minstall is done :)');
      }

      let moduleText = 'modules';
      if (moduleInfos.length === 1) {
        moduleText = 'module';
      }
      logIfInRoot(`minstall found ${moduleInfos.length} local ${moduleText} in '${moduletools.modulesFolder}'`);
      return installModules(installedModules, moduleInfos);
    })
    .then(() => {
      logIfInRoot(`\nminstall finished in ${systools.getRuntime(startTime)} :)\n\n`);
    })
    .catch(UncriticalError, (error) => {
      logIfInRoot(error.message);
    });
}

run();
