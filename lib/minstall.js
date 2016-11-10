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

function runPostinstall(moduleInfo) {

  if (!moduleInfo.postinstall) {
    return Promise.resolve();
  }

  const modulePath = path.join(process.cwd(), moduletools.modulesFolder, moduleInfo.folderName);
  return linkRootToModule(moduleInfo.folderName)
    .then(() => {

      return systools.runCommand(`cd ${modulePath}${commandConcatSymbol} ${moduleInfo.postinstall}`);
    })
    .then(() => {

      return systools.delete(path.join(modulePath, 'node_modules'));
    });
}

function getLocalPackageInfo() {
  return ModuleInfo.loadFromFolder('', '');
}

function checkStartConditions() {

  let nodeModulesIsSymlink = false;
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

      return systools.isSymlink(path.join(process.cwd(), 'node_modules'));
    })
    .then((isSymlink) => {
      
      nodeModulesIsSymlink = isSymlink;
      return getLocalPackageInfo();
    })
    .then((localPackageInfo) => {

      if (!nodeModulesIsSymlink && !localPackageInfo.dependencies.minstall) {
        throw new UncriticalError('minstall started from outside the project-root. aborting.');
      }

      return localPackageInfo;
    });
}

function installModuleDependencies(installedModules, moduleInfos) {

  const dependencies = moduletools.getModuleDependencies(installedModules, moduleInfos);
  if (dependencies.length > 0) {
    return systools.runCommand(`npm install ${dependencies.join(' ')}`)
      .catch((error) => {

        // This error might just be a warning from npm-install
        process.stdout.write(error.message);
      });
  }

  return Promise.resolve();
}

function getRuntime(start) {
  let runSeconds = Math.round(((new Date()).getTime() - start) / 1000);
  const runMinutes = Math.floor(runSeconds / 60);
  runSeconds %= 60;

  if (runMinutes === 0) {
    return `${runSeconds} seconds`;
  }

  if (runSeconds < 10) {
    runSeconds = `0${runSeconds}`;
  }
  return `${runMinutes}:${runSeconds} minutes`;
}

function cacheConflictingModules(dependencies, moduleFolderName) {

  if (dependencies.conflicted.length === 0) {
    return Promise.resolve();
  }

  const conflictedDependencyFolders = dependencies.conflicted.map((dependency) => {
    return dependency.folderName;
  });

  const rootNodeModules = path.join(process.cwd(), 'node_modules');
  const cacheFolder = path.join(rootNodeModules, `${moduleFolderName}_cache`);
  return systools.moveMultiple(conflictedDependencyFolders, rootNodeModules, cacheFolder);
}

function keepModulePackets(packetsToKeep, moduleFolderName) {

  const packetFolderNames = packetsToKeep.map((packet) => {
    return packet.folderName;
  });

  const rootNodeModules = path.join(process.cwd(), 'node_modules');
  const moduleNodeModules = path.join(process.cwd(), moduletools.modulesFolder, moduleFolderName, 'node_modules');
  return systools.moveMultiple(packetFolderNames, moduleNodeModules, rootNodeModules);
}

function uncacheConflictingModules(dependencies, moduleFolderName) {

  if (dependencies.conflicted.length === 0) {
    return Promise.resolve();
  }

  const conflictedDependencyFolders = dependencies.conflicted.map((dependency) => {
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

function installModules(installedModules, moduleInfos, index) {

  index = index || 0;
  if (index >= moduleInfos.length) {
    return Promise.resolve();
  }

  if (index > 0) {
    readline.clearLine(process.stdout);
    readline.cursorTo(process.stdout, 0);
  }

  const moduleDetails = moduleInfos[index];
  process.stdout.write(`- installing ${moduleDetails.folderName} (${index + 1}/${moduleInfos.length})`);

  const deps = moduletools.getModuleDependencies(installedModules, moduleDetails);

  const nextInstall = () => {
    return installModules(installedModules, moduleInfos, index + 1);
  };

  const moduleNodeModules = path.join(process.cwd(), moduletools.modulesFolder,
                                      moduleDetails.folderName, 'node_modules');
  let packetsToKeep;

  return moduletools.getModules(path.join(moduletools.modulesFolder, moduleDetails.folderName, 'node_modules'))
    .then((modules) => {
      
      packetsToKeep = moduletools.removeAvaliablePackets(modules, deps.missing);
      deps.missing = packetsToKeep.missing;
      packetsToKeep = packetsToKeep.keep;

      return cacheConflictingModules(deps, moduleDetails.folderName);
    })
    .then(() => {

      return keepModulePackets(packetsToKeep, moduleDetails.folderName);
    })
    .then(() => {

      return systools.delete(moduleNodeModules);
    })
    .then(() => {

      return moduletools.installPackets(deps.missing);
    })
    .then(() => {

      return runPostinstall(moduleDetails);
    })
    .then(() => {

      return uncacheConflictingModules(deps, moduleDetails.folderName);
    })
    .then(() => {

      linkModuleToRoot(moduleDetails.folderName);
    })
    .then(() => {

      return moduletools.getModules('node_modules');
    })
    .then((modules) => {

      installedModules = modules;
      return nextInstall();
    });
}

function run() {
  const startTime = (new Date()).getTime();
  if (process.argv[2]) {
    moduletools.setModulesFolder(process.argv[2]);
  }

  if (os.platform() === 'win32') {
    commandConcatSymbol = '&';
  }

  let projectModules = null;
  let installedModules = null;
  let localPackageInfo = null;
  checkStartConditions()
    .then((packageInfo) => {
      localPackageInfo = packageInfo;
      return moduletools.getModules('node_modules');
    })
    .then((modules) => {
      installedModules = modules;
      return moduletools.getModules();
    })
    .then((moduleInfos) => {
      projectModules = moduleInfos;
      if (moduleInfos.length === 0) {
        throw new UncriticalError('no modules found, thus minstall is done :)');
      }

      moduletools.logModules(moduleInfos);
      return installModules(installedModules, moduleInfos);
    })
    .then(() => {

      console.log(`\n\nminstall finished in ${getRuntime(startTime)} :)\n\n`);
    })
    .catch(UncriticalError, (error) => {

      console.log(error.message);
    });
}

run();
