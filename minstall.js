#!/usr/bin/env node
"use strict";

const fs = require('fs');
const os = require('os');
const path = require('path');
const exec = require('child_process').exec;
const Promise = require('bluebird');
const readline = require('readline');

let modulesFolder = 'modules';
let commandConcatSymbol = ';';

class UncriticalError extends Error {
  constructor(message) {
    super(message);
  }
}

const run = () => {
  if (process.argv[2]) {
    modulesFolder = process.argv[2];
  }
  
  const startTime = (new Date()).getTime();

  if (os.platform() === 'win32') {
    commandConcatSymbol = '&';
  }

  let projectModules = null;
  let installedModules = null;
  _verifyFolderName(process.cwd(), 'node_modules')
    .then((folderName) => {

      if (folderName == null) {
        throw new UncriticalError(`minstall started from outside the project-root. aborting.`);
      }

      return _verifyFolderName(process.cwd(), modulesFolder);
    })
    .then((folderName) => {

      if (folderName == null) {
        throw new UncriticalError(`${modulesFolder} not found, thus minstall is done :)`);
      }

      return getModules('node_modules');
    })
    .then((modules) => {

      installedModules = modules;
      return getModules();
    })
    .then((moduleInfos) => {

      projectModules = moduleInfos;
      if (moduleInfos.length === 0) {
        throw new UncriticalError('no modules found, thus minstall is done :)');
      }

      _logModules(moduleInfos);
      console.log('\n- installing module-dependencies');

      const dependencies = _getModuleDependencies(installedModules, moduleInfos);
      if (dependencies.length > 0) {
        return _runCommand(`npm install ${dependencies.join(' ')}`);
      }
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
      console.log(`\n\nminstall finished in ${runMinutes}:${runSeconds%60} minutes :)\n\n`);
    })
    .catch(UncriticalError, (error) => {

      console.log(error.message);
    })
    .catch((error) => {

      console.log('Error running minstall', error);
    });
};

const getModules = (rootFolder) => {

  if (!rootFolder) {
    rootFolder = modulesFolder;
  }

  const modulesPath = path.join(process.cwd(), rootFolder);
  return _getFolderNames(modulesPath)
    .then((folderNames) => {

      return Promise.all(folderNames.map((folderName) => {
        return _verifyModule(modulesPath, folderName);
      }));
    })
    .then((moduleNames) => {

      const modules = moduleNames.filter((moduleName) => {
        return moduleName != null;
      });

      return Promise.all(modules.map((moduleName) => {
        return getModuleInfo(rootFolder, moduleName);
      }));
    });
};

const getModuleInfo = (rootFolder, moduleFolder) => {
  return new Promise((resolve, reject) => {

    if (!rootFolder) {
      rootFolder = modulesFolder;
    }

    const packagePath = path.join(process.cwd(), rootFolder, moduleFolder, 'package.json');
    fs.readFile(packagePath, 'utf8', (error, data) => {

      if (error) {
        return reject(error);
      }

      const packageInfo = JSON.parse(data);
      const dependencies = packageInfo.dependencies || [];
      if ((!process.env.NODE_ENV || process.env.NODE_ENV !== 'production')
          && packageInfo.devDependencies) {
        for (let dependency in packageInfo.devDependencies) {
          dependencies[dependency] = packageInfo.devDependencies[dependency];
        }
      }

      const result = {
        folderName: moduleFolder,
        name: packageInfo.name,
        version: packageInfo.version,
        dependencies: dependencies,
      };

      if (packageInfo.scripts && packageInfo.scripts.postinstall) {
        result.postinstall = packageInfo.scripts.postinstall;
      }

      return resolve(result);
    });
  });
};

const linkModulesToRoot = (moduleFolders) => {

  const targetFolder = path.join(process.cwd(), 'node_modules');
  const moduleRoot = path.join(process.cwd(), modulesFolder);

  return Promise.all(moduleFolders.map((moduleFolder) => {
    return _link(path.join(moduleRoot, moduleFolder), path.join(targetFolder, moduleFolder));
  }));
};

const linkRootToModule = (moduleFolder) => {

  const rootModuleFolder = path.join(process.cwd(), 'node_modules');
  const targetFolder = path.join(process.cwd(), modulesFolder, moduleFolder, 'node_modules');

  return _link(rootModuleFolder, targetFolder);
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

      return _runCommand(`cd ${path.join(process.cwd(), modulesFolder, moduleDetails.folderName)}${commandConcatSymbol} ${moduleDetails.postinstall}`);
    })
    .then(() => {

      return _delete(path.join(process.cwd(), modulesFolder, moduleDetails.folderName, 'node_modules'));
    })
    .then(() => {

      return nextPostinstall();
    });
};

const _delete = (location) => {
  return new Promise((resolve, reject) => {
    fs.unlink(location, (error) => {
      if (error) {
        console.log(`error deleting '${location}'`, error);
      }

      return resolve();
    });
  });
};

const _link = (modulePath, targetPath) => {

  return new Promise((resolve, reject) => {
    fs.symlink(modulePath, targetPath, 'junction', (error) => {

      // even if the link-command failed (e.g. when the link already exists), the script should continue, thus there is no reject
      return resolve();
    });
  });
};

const _runCommand = (command) => {

  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error !== null) {
        console.log('ERROR RUNNING COMMAND', command, error);
        return reject(error);
      }

      return resolve(stdout);
    });
  });
};

const _getModuleDependencies = (installedModules, moduleInfos) => {

  const dependencies = [];
  const installingModules = [];
  const installedModuleNames = installedModules.map((module) => {
    return module.name;
  })

  for (let index = 0; index < moduleInfos.length; index++) {
    for (let name in moduleInfos[index].dependencies) {

      if (installedModuleNames.indexOf(name) >= 0 || installingModules.indexOf(name) >= 0) {
        continue;
      }

      dependencies.push(`${name}@"${moduleInfos[index].dependencies[name]}"`);
      installingModules.push(name);
    }
  }

  return dependencies;
};

const _getFolderNames = (folderPath) => {
  return new Promise((resolve, reject) => {

    fs.readdir(folderPath, (error, files) => {
      if (error) {
        return reject(error);
      }

      return resolve(Promise.all(files.map((file) => {
        return _verifyFolderName(folderPath, file);
      })));
    });
  })
  .then((moduleNames) => {

    return moduleNames.filter((moduleName) => {
      return moduleName != null;
    });
  });
};

const _verifyFolderName = (folderPath, folderName) => {
  if (folderName.indexOf('.') === 0) {
    return Promise.resolve(null);
  }

  const folder = path.join(folderPath, folderName);
  return new Promise((resolve, reject) => {
    fs.stat(folder, (error, stats) => {
      if (error) {
        if (error.code === 'ENOENT') {
          return resolve(null);
        }

        return reject(error);
      }

      if (!stats.isDirectory()) {
        return resolve(null);
      }

      return resolve(folderName);
    });
  });
};

const _verifyModule = (location, name) => {
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
};

const _logModules = (moduleInfos) => {

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
};

run();
