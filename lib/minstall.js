#!/usr/bin/env node

'use strict';

const os = require('os');
const path = require('path');
const Promise = require('bluebird');
const readline = require('readline');

const UncriticalError = require('./UncriticalError.js');
const systools = require('./systools.js');
const moduletools = require('./moduletools.js');

let commandConcatSymbol = ';';

const linkModulesToRoot = (moduleFolders) => {
  return Promise.all(moduleFolders.map((moduleFolder) => {
    const targetPath = path.join(process.cwd(), 'node_modules', moduleFolder);
    const modulePath = path.join(process.cwd(), moduletools.modulesFolder, moduleFolder);
    return systools.link(modulePath, targetPath);
  }));
};

const linkRootToModule = (moduleFolder) => {
  const rootModuleFolder = path.join(process.cwd(), 'node_modules');
  const targetFolder = path.join(process.cwd(), moduletools.modulesFolder, moduleFolder, 'node_modules');

  return systools.link(rootModuleFolder, targetFolder);
};

const runPostinstalls = (moduleInfos, index, noPostinstallCount) => {
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

  process.stdout.write(`- running postinstall for ${moduleDetails.folderName} (${(index + 1 - noPostinstallCount)}/${postinstallCount})`);
  return linkRootToModule(moduleDetails.folderName)
    .then(() => {
      return systools.runCommand(`cd ${path.join(process.cwd(), moduletools.modulesFolder, moduleDetails.folderName)}${commandConcatSymbol} ${moduleDetails.postinstall}`);
    })
    .then(() => {
      return systools.delete(path.join(process.cwd(), moduletools.modulesFolder, moduleDetails.folderName, 'node_modules'));
    })
    .then(() => {
      return nextPostinstall();
    });
};

const run = () => {
  if (process.argv[2]) {
    moduletools.setModulesFolder(process.argv[2]);
  }

  const startTime = (new Date()).getTime();

  if (os.platform() === 'win32') {
    commandConcatSymbol = '&';
  }

  let projectModules = null;
  let installedModules = null;
  systools.verifyFolderName(process.cwd(), 'node_modules')
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
      console.log('\n- installing module-dependencies');

      const dependencies = moduletools.getModuleDependencies(installedModules, moduleInfos);
      if (dependencies.length > 0) {
        return systools.runCommand(`npm install ${dependencies.join(' ')}`);
      }

      return null;
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
      let runSeconds = Math.round(((new Date()).getTime() - startTime) / 1000);
      const runMinutes = Math.floor(runSeconds / 60);
      runSeconds %= 60;

      if (runMinutes === 0) {
        console.log(`\n\nminstall finished in ${runSeconds} seconds :D\n\n`);
      } else {
        if (runSeconds < 10) {
          runSeconds = `0${runSeconds}`;
        }
        console.log(`\n\nminstall finished in ${runMinutes}:${runSeconds} minutes :)\n\n`);
      }
    })
    .catch(UncriticalError, (error) => {
      console.log(error.message);
    })
    .catch((error) => {
      console.log('Error running minstall', error);
      throw error;
    });
};

run();
