#!/usr/bin/env node

'use strict';

const os = require('os');
const path = require('path');
const Promise = require('bluebird');
const readline = require('readline');

const UncriticalError = require('./UncriticalError.js');
const InstalledVersionMismatchError = require('./InstalledVersionMismatchError.js');
const systools = require('./systools.js');
const moduletools = require('./moduletools.js');
const ModuleInfo = require('./ModuleInfo');

let commandConcatSymbol = ';';

function linkModulesToRoot(moduleFolders) {
  return Promise.all(moduleFolders.map((moduleFolder) => {
    const targetPath = path.join(process.cwd(), 'node_modules', moduleFolder);
    const modulePath = path.join(process.cwd(), moduletools.modulesFolder, moduleFolder);
    return systools.link(modulePath, targetPath);
  }));
}

function linkRootToModule(moduleFolder) {
  const rootModuleFolder = path.join(process.cwd(), 'node_modules');
  const targetFolder = path.join(process.cwd(), moduletools.modulesFolder, moduleFolder, 'node_modules');

  return systools.link(rootModuleFolder, targetFolder);
}

function runPostinstalls(moduleInfos, index, noPostinstallCount) {
  index = index || 0;
  noPostinstallCount = noPostinstallCount || 0;

  if (index >= moduleInfos.length) {
    return Promise.resolve();
  }

  const nextPostinstall = () => {
    return runPostinstalls(moduleInfos, index + 1, noPostinstallCount);
  };

  const moduleDetails = moduleInfos[index];
  if (!moduleDetails.postinstall) {
    noPostinstallCount += 1;
    return nextPostinstall();
  }

  const postinstallCount = moduleInfos.filter((moduleInfo) => {
    return moduleInfo.postinstall;
  }).length;

  if (index > 0) {
    readline.clearLine(process.stdout);
    readline.cursorTo(process.stdout, 0);
  }

  const progress = `${((index + 1) - noPostinstallCount)}/${postinstallCount}`;
  process.stdout.write(`- running postinstall for ${moduleDetails.folderName} (${progress})`);

  const modulePath = path.join(process.cwd(), moduletools.modulesFolder, moduleDetails.folderName);
  const nodeModules = path.join(modulePath, 'node_modules');
  return linkRootToModule(moduleDetails.folderName)
    .then(() => {
      return systools.runCommand(`cd ${modulePath}${commandConcatSymbol} ${moduleDetails.postinstall}`);
    })
    .then(() => {
      return systools.delete(nodeModules);
    })
    .then(() => {
      return nextPostinstall();
    })
    .catch((error) => {
      return systools.delete(nodeModules)
        .then(() => {
          throw error
        });
    });
}


function chekForNecessaryFolders() {
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
    });
}

function installModuleDependencies(installedModules, moduleInfos) {
  console.log('\n- installing module-dependencies');

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

function getLocalPackageInfo() {
  return ModuleInfo.loadFromFolder('', '');
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
  chekForNecessaryFolders()
    .then(() => {
      return getLocalPackageInfo();
    })
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
      return installModuleDependencies(installedModules, moduleInfos);
    })
    .then(() => {
      console.log('- linking modules to ./node_modules');
      linkModulesToRoot(projectModules.map((module) => {
        return module.folderName;
      }));
    })
    .then(() => {
      return runPostinstalls(projectModules);
    })
    .then(() => {
      console.log(`\n\nminstall finished in ${getRuntime(startTime)} :)\n\n`);
    })
    .catch(UncriticalError, (error) => {
      console.log(error.message);
    })
    .catch(InstalledVersionMismatchError, (error) => {
      console.log(error);
      throw new Error(`dependency-version-mismatch when trying to install local modules for ${localPackageInfo.name}: ${error.message}`);
    });
}

run();
