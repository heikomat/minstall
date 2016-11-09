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
  return systools.runCommand(`cd ${modulePath}${commandConcatSymbol} ${moduleInfo.postinstall}`);
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

function installModules(installedModules, moduleInfos, index) {

  index = index || 0;
  if (index >= moduleInfos.length) {
    return Promise.resolve();
  }

  const moduleDetails = moduleInfos[index];
  const deps = moduletools.getModuleDependencies(installedModules, moduleDetails);

  const nextInstall = () => {
    return installModules(installedModules, moduleInfos, index + 1);
  }

  console.log(deps);
  if (deps.missing.length === 0 && deps.conflicted.length === 0 && !moduleDetails.postinstall) {
    return nextInstall();
  }

  const rootNodeModules = path.join(process.cwd(), 'node_modules');
  const cacheFolder = path.join(rootNodeModules, `${moduleDetails.folderName}_cache`);
  const moduleFolder = path.join(process.cwd(), moduletools.modulesFolder, moduleDetails.folderName);
  const moduleNodeModules = path.join(moduleFolder, 'node_modules');
  let packetsToKeep;

  // bereits installierte extra-module durchsuchen
  console.log('lade Module')
  return moduletools.getModules(path.join(moduletools.modulesFolder, 'node_modules'))
    .then((modules) => {
      // Prüfen, welche der extra-module noch benötigt werden
      packetsToKeep = moduletools.removeAvaliablePackets(modules, deps.missing);
      deps.missing = packetsToKeep.missing;
      packetsToKeep = packetsToKeep.keep;

      if (deps.conflicted.length === 0) {
        return;
      }

      // ordner zum wegcachen der conflicted-dependencies erstellen
      console.log('erstelle cache folder', cacheFolder)
      return systools.createDir(cacheFolder)
        .then(() => {

          // die conflicted dependencies wegcachen
          return Promise.all(deps.conflicted.map((dependency) => {

            const source = path.join(rootNodeModules, dependency.folderName);
            const target = path.join(cacheFolder, dependency.folderName);
            return systools.moveFolder(source, target);
          }))
        });
    })
    .then(() => {

      // Die packets to keep nach node_modules veschieben
      console.log('keep-packets behalten')
      return Promise.all(packetsToKeep.map((packet) => {

        const source = path.join(moduleFolder, 'node_modules', packet.folderName);
        const target = path.join(rootNodeModules, packet.folderName);
        return systools.moveFolder(source, target);
      }));

    })
    .then(() => {

      // Den aktuellen node_modules-ordner killen, falls vorhanden
      console.log('aktuellen node_modules killen')
      return systools.delete(path.join(moduleFolder, 'node_modules'));
    })
    .then(() => {

      // fehlende dependencies installieren
      console.log('dependencies installieren')
      return moduletools.installPackets(deps.missing);
    })
    .then(() => {

      console.log('root in module ordner linken')
      return linkRootToModule(moduleDetails.folderName);
    })
    .then(() => {

      // Postinstall ausführen
      console.log('postinstall ausführen')
      return runPostinstall(moduleDetails);
    })
    .then(() => {

      // den vor dem postinstall verlinkten node_modules wieder löschen
      console.log('node_modules im modul-ordner killen')
      return systools.delete(moduleNodeModules);
    })
    .then(() => {

      // neu installierte Module, die vorher conflicteten nach folderName/node_modules_conflicted verschieben
      if (deps.conflicted.length === 0) {
        return Promise.resolve();
      }

      // target-ordner zum wegcachen der conflicted-dependencies erstellen
      console.log('conflictete pakete ins modul-node-modules verschieben')
      return systools.createDir(path.join(moduleFolder, 'node_modules'))
        .then(() => {

          // die conflicted dependencies wegcachen
          return Promise.all(deps.conflicted.map((dependency) => {

            const source = path.join(rootNodeModules, dependency.folderName);
            const target = path.join(moduleNodeModules, dependency.folderName);
            return systools.moveFolder(source, target);
          }));
        });
    })
    .then(() => {

      // Die weggecachten pakete wieder nach node_modules verschieben
      if (deps.conflicted.length === 0) {
        return Promise.resolve();
      }

      console.log('gecachte pakete wieder nach node-modules verschieben')
      return Promise.all(deps.conflicted.map((dependency) => {

        const source = path.join(cacheFolder, dependency.folderName);
        const target = path.join(rootNodeModules, dependency.folderName);
        return systools.moveFolder(source, target);
      }));
    })
    .then(() => {
      // node_modules/folderName löschen
      if (deps.conflicted.length > 0) {
        console.log('cache-ordner killen')
        return systools.deleteFolder(path.join(cacheFolder));
      }

      return null;
    })
    .then(() => {
      // Modul ins root-node-modules verlinken
      console.log('Modul in den root verlinken', moduleDetails)
      linkModuleToRoot(moduleDetails.folderName);
    })
    .then(() => {
      // Liste der installierten module aktualisieren
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
      return installModules(installedModules, moduleInfos);
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
