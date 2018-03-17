#!/usr/bin/env node
import * as minimatch from 'minimatch';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import * as semver from 'semver';
import {intersect} from 'semver-intersect';
import * as logger from 'winston';

const cwd: string = process.cwd();

import {
  DependencyInfo,
  DependencyRequestInfo,
  DependencyRequests,
  DependencyTargetFolder,
  ModulesAndDependenciesInfo,
  SemverRange,
} from './interfaces';
import {ModuleInfo} from './module_info';
import {ModuleTools} from './moduletools';
import {SystemTools} from './systools';
import {UncriticalError} from './uncritical_error';

let commandConcatSymbol: string = ';';
let isInProjectRoot: boolean = true;
let localPackage: ModuleInfo = null;

let installedAsDependency: boolean = false;
let projectFolderName: string = null;
let linkModules: boolean = true;
let npmVersion: string = null;
let cleanup: boolean = false;
let dependencyCheckOnly: boolean = false;
let linkOnly: boolean = false;
let assumeLocalModulesSatisfyNonSemverDependencyVersions: boolean = false;
const noHoistList: Array<DependencyInfo> = [];

function logVerbose(): boolean {
  return ['verbose', 'debug', 'silly'].indexOf(logger.level) >= 0;
}

function logIfInRoot(message: string): void {
  if (message && message.length > 0 && (isInProjectRoot || logVerbose())) {
    // tslint:disable-next-line:no-console
    console.log(message);
  }
}

function getLocalPackageInfo(): Promise<ModuleInfo> {
  return ModuleInfo.loadFromFolder(cwd, '');
}

async function checkStartConditions(): Promise<void> {
  logger.debug('checking start conditions');

  let folderName: string = await SystemTools.verifyFolderName(cwd, 'node_modules');
  localPackage = await getLocalPackageInfo();
  npmVersion = await SystemTools.runCommand('npm --version', true);

  if (semver.satisfies(npmVersion, '5.7.0')) {
    logger.error(`You're using npm 5.7.0. Do not use this version, it has a critical bug that is fixed in 5.7.1. See npm-issue #19883 for more info`);
    process.exit(1);
  }

  // npm 5 workaround until npm-issue #16853 is fixed replace the if-confition
  // and log when npm >= 5.7.1 is confirmed working without that workaround
  // if (semver.satisfies(npmVersion, '>=5.0.0 <5.7.0')) {
  const buggyNpmVersion: number = 5;
  if (semver.major(npmVersion) === buggyNpmVersion) {
    // logger.info('npm >=5.0.0 <5.7.0 detected. forcing --cleanup');
    logger.info('npm 5 detected. forcing --cleanup');
    cleanup = true;
  }

  const pathParts: Array<string> = cwd.split(path.sep);
  let parentFolder: string;

  if (!localPackage.isScoped) {
    const parentFolderIndexDifference: number = 2;
    parentFolder = pathParts[pathParts.length - parentFolderIndexDifference];
  } else {
    const scopedParentFolderIndexDifference: number = 3;
    parentFolder = pathParts[pathParts.length - scopedParentFolderIndexDifference];
  }

  if (parentFolder === 'node_modules') {
    logger.debug('project is in a node_modules folder. It\'s therefore installed as a dependency');
    installedAsDependency = true;
  }

  if (folderName === null) {
    logger.debug('project folder has no node_modules-folder');

    if (!installedAsDependency) {
      logger.debug('project is not in a node_modules folder');
      throw new UncriticalError('minstall started from outside the project-root. aborting.');
    }
  } else {
    logger.debug('project folder has node_modules-folder');
  }

  folderName = '.';
  if (ModuleTools.modulesFolder !== '.') {
    folderName = await SystemTools.verifyFolderName(cwd, ModuleTools.modulesFolder);
  }

  if (folderName === null) {
    throw new UncriticalError(`${ModuleTools.modulesFolder} not found, thus minstall is done :)`);
  }

  if (installedAsDependency) {
    return;
  }

  if (installedAsDependency) {
    return;
  }

  if (isInProjectRoot) {
    isInProjectRoot = !await SystemTools.isSymlink(path.join(cwd, 'node_modules'));
  }

  if (isInProjectRoot && !localPackage.dependencies.minstall) {
    throw new UncriticalError('minstall started from outside the project-root. aborting.');
  }
}

function setupLogger(): void {
  logger.remove(logger.transports.Console);
  logger.add(logger.transports.Console, {
    stderrLevels: ['warn', 'error', 'critial'],
    colorize: true,
    handleExceptions: true,
    humanReadableUnhandledException: true,
    timestamp: false,
    prettyPrint: true,
  });

  const logLevels: {[loglevel: string]: {level: number, color: string}} = {
    critical: {level: 0, color: 'red'},
    error: {level: 1, color: 'magenta'},
    warn: {level: 2, color: 'yellow'},
    info: {level: 3, color: 'green'},
    verbose: {level: 4, color: 'gray'},
    debug: {level: 5, color: 'blue'},
    silly: {level: 6, color: 'cyan'},
  };
  const levels: logger.AbstractConfigSetLevels = {};
  const colors: logger.AbstractConfigSetColors = {};

  Object.keys(logLevels)
    .forEach((name: string) => {
      levels[name] = logLevels[name].level;
      colors[name] = logLevels[name].color;
    });

  logger.setLevels(levels);
  logger.addColors(colors);
}

function findRequestedDependencies(localModules: Array<ModuleInfo>): DependencyRequests {
  const requestedDependencies: DependencyRequests = {};
  for (const module of localModules) {
    for (const dependency in module.dependencies) {
      const requestedVersion: SemverRange = module.dependencies[dependency];
      if (requestedDependencies[dependency] === undefined) {
        requestedDependencies[dependency] = {};
      }

      let versionFound: boolean = false;
      for (const version in requestedDependencies[dependency]) {
        let intersection: SemverRange = null;
        try {
          intersection = intersect(version, requestedVersion);
        } catch (error) {
          // the versions didn't intersect. That's ok!
        }

        if (intersection) {
          if (intersection !== version) {
            requestedDependencies[dependency][intersection] = requestedDependencies[dependency][version];
            delete requestedDependencies[dependency][version];
          }

          requestedDependencies[dependency][intersection].push(module.fullModulePath);
          versionFound = true;

          // we don't wan't that module to end up in multiple version-lists of that dependency
          break;
        }
      }

      if (!versionFound) {
        if (requestedDependencies[dependency][module.dependencies[dependency]] !== undefined) {
          // the requested version wasn't found, but the exact version is already in the requested dependencies
          // This means, that semver-intersect couldn't parse the version, which means it's not a semver-version
          requestedDependencies[dependency][module.dependencies[dependency]].push(module.fullModulePath);
        } else {
          requestedDependencies[dependency][module.dependencies[dependency]] = [
            module.fullModulePath,
          ];
        }
      }
    }
  }

  return requestedDependencies;
}

function removeAlreadySatisfiedDependencies(requestedDependencies: DependencyRequests,
                                            localModules: Array<ModuleInfo>,
                                            alreadyInstalledDependencies: Array<ModuleInfo>): DependencyRequests {

  const result: DependencyRequests = {...requestedDependencies};

  for (const requestedDependencyName in result) {
    for (const requestedDependencyVersionRange in result[requestedDependencyName]) {

      // check if already installed modules satisfy the dependency
      for (const installedDependency of alreadyInstalledDependencies) {
        if (requestedDependencyName !== installedDependency.name) {
          continue;
        }

        if (!semver.satisfies(installedDependency.version, requestedDependencyVersionRange)) {
          continue;
        }

        for (const locationOfRequestingModule of result[requestedDependencyName][requestedDependencyVersionRange]) {
          // It doesn't matter where the dependency with the correct version is! all shadowed dependencies
          // get fixed with symlinks after the installation!
          const shortenedRequesterLocation: string = locationOfRequestingModule.substr(cwd.length);
          const shortenedInstalledLocation: string = installedDependency.location.substr(cwd.length);

          // tslint:disable-next-line:max-line-length
          logger.debug(`dependency ${requestedDependencyName}@${requestedDependencyVersionRange} requested by '${shortenedRequesterLocation}' will be satisfied by installed version ${installedDependency.version} in '${path.join(shortenedInstalledLocation)}'`);
        }

        delete result[requestedDependencyName][requestedDependencyVersionRange];
        break;
      }

      if (!result[requestedDependencyName][requestedDependencyVersionRange] ||
        result[requestedDependencyName][requestedDependencyVersionRange].length === 0) {
        delete result[requestedDependencyName][requestedDependencyVersionRange];
        continue;
      }

      // check if local modules that will get linked satisfy the dependency
      if (!linkModules) {
        continue;
      }

      for (const localModule of localModules) {
        if (requestedDependencyName !== localModule.name) {
          continue;
        }

        const rangeIsValidAndSatisfied: boolean = semver.validRange(requestedDependencyVersionRange)
                                               && semver.satisfies(localModule.version, requestedDependencyVersionRange);

        const rangeIsInvalidAndAssumedToBeSatisfied: boolean = !semver.validRange(requestedDependencyVersionRange)
                                                             && assumeLocalModulesSatisfyNonSemverDependencyVersions;

        const dependencyIsSatisfiedByLocalModule: boolean = rangeIsValidAndSatisfied || rangeIsInvalidAndAssumedToBeSatisfied;
        if (!dependencyIsSatisfiedByLocalModule) {
          continue;
        }

        const shortenedLocalLocation: string = `.${localModule.location.substr(cwd.length)}`;
        const requesterLocations: Array<string> = result[requestedDependencyName][requestedDependencyVersionRange];
        const shortenedRequesterLocations: Array<string> = requesterLocations.map((locationOfRequestingModule: string) => {
          return `.${locationOfRequestingModule.substr(cwd.length)}`;
        });

        if (rangeIsInvalidAndAssumedToBeSatisfied) {
          // tslint:disable-next-line:max-line-length
          logger.info(`Assuming that local module ${shortenedLocalLocation} satisfies ${requestedDependencyName}@${requestedDependencyVersionRange} requested by ${shortenedRequesterLocations.join(', ')}`);
        }

        for (const locationOfRequestingModule of result[requestedDependencyName][requestedDependencyVersionRange]) {
          // if the version matches the local module will satisfy the dependency, because even if it would get shadowed,
          // shadowed dependencies will get fixed with symlinks!
          const shortenedRequesterLocation: string = `.${locationOfRequestingModule.substr(cwd.length)}`;
          // tslint:disable-next-line:max-line-length
          logger.debug(`dependency ${requestedDependencyName}@${requestedDependencyVersionRange} requested by '${shortenedRequesterLocation}' will be satisfied by local version ${localModule.version} in '${path.join(shortenedLocalLocation)}'`);
        }
        delete result[requestedDependencyName][requestedDependencyVersionRange];
        break;
      }
    }
    if (Object.keys(result[requestedDependencyName]).length === 0) {
      delete result[requestedDependencyName];
    }
  }

  return result;
}

function dependenciesToArray(dependencies: DependencyRequests): Array<DependencyRequestInfo> {
  const result: Array<DependencyRequestInfo> = [];

  for (const dependencyName in dependencies) {
    for (const dependencyVersionRange in dependencies[dependencyName]) {
      result.push({
        name: dependencyName,
        versionRange: dependencyVersionRange,
        identifier: `${dependencyName}@"${dependencyVersionRange}"`,
        requestedBy: dependencies[dependencyName][dependencyVersionRange],
      });
    }
  }

  return result;
}

function _dontHoistDependency(optimalDependencyTargetFolder: DependencyTargetFolder, requestedDependency: DependencyRequestInfo): void {
  for (const installationTarget of requestedDependency.requestedBy) {

    if (!optimalDependencyTargetFolder[installationTarget]) {
      optimalDependencyTargetFolder[installationTarget] = [];
    }

    optimalDependencyTargetFolder[installationTarget].push(requestedDependency);
  }
}

function determineDependencyTargetFolder(requestedDependencyArray: Array<DependencyRequestInfo>,
                                         alreadyInstalledDependencies: Array<ModuleInfo>): DependencyTargetFolder {

  const optimalDependencyTargetFolder: DependencyTargetFolder = {};
  for (const requestedDependency of requestedDependencyArray) {

    const requestedVersionIsValidSemver: string = semver.validRange(requestedDependency.versionRange);
    if (requestedVersionIsValidSemver === null) {
      // if the requested version is NOT valid semver, we can't hoist the
      // dependency. This is the case for github urls. In that case we just
      // install the dependency to the folder it is requested in.
      const requestedByString: string = requestedDependency.requestedBy.map((requestedByPath: string) => {
        return `.${requestedByPath.substr(cwd.length)}`;
      }).join('\n  ');

      // tslint:disable-next-line:max-line-length
      logger.warn(`${requestedDependency.requestedBy.length} modules request ${requestedDependency.identifier}. This dependency won't get optimized (hoisted), because '${requestedDependency.versionRange}' is not a vaild semver-range. If ${requestedDependency.name} is one of your local modules, you can try the --trust-local-modules flag. These modules all get their own copy of that Dependency:\n  ${requestedByString}`);
      _dontHoistDependency(optimalDependencyTargetFolder, requestedDependency);
      continue;
    }

    const matchingNoHoistEntry: DependencyInfo = noHoistList.find((noHoistEntry: DependencyInfo) => {
      // if the name of the requrested dependency doesn't match the noHoistEntry, then this noHoistEntry should
      // not affect the hoisting of that dependency
      if (!minimatch(requestedDependency.name, noHoistEntry.name)) {
        return false;
      }

      if (noHoistEntry.versionRange === undefined) {
        return true;
      }

      if (requestedDependency.versionRange === noHoistEntry.versionRange) {
        return true;
      }

      try {
        const intersection: SemverRange = intersect(requestedDependency.versionRange, noHoistEntry.versionRange);
      } catch (error) {
        // the versions didn't intersect
        return false;
      }

      // the versions do intersect
      return true;
    });

    if (matchingNoHoistEntry !== undefined) {
      // The requested dependency is flagged as "should not get hoisted", so we don't hoist it.
      const requestedByString: string = requestedDependency.requestedBy.map((requestedByPath: string) => {
        return `.${requestedByPath.substr(cwd.length)}`;
      }).join('\n  ');

      // tslint:disable-next-line:max-line-length
      logger.info(`${requestedDependency.identifier} instersects with no-hoist-flag ${matchingNoHoistEntry.identifier}, so it won't get hoisted for the following modules:\n  ${requestedByString}`);
      _dontHoistDependency(optimalDependencyTargetFolder, requestedDependency);
    }

    // If we work with valid semver, it doesn't matter where the dependency
    // gets Installed, even if mutliple modules need it, because in that case
    // it will be symlinked from wherever it is installed. Because of this we
    // just work with the path of the first module that requests this dependency
    const possiblePathElements: Array<string> = requestedDependency.requestedBy[0]
      .substr(cwd.length)
      .split(path.sep)
      .filter((pathElement: string) => {
        return pathElement.length > 0;
      });

    // because we check the current path first, and then add the path element, the last element won't be checked.
    // because of that we just add another pathElement that will be ignored, but will make the last real
    // pathElement not be ignored
    possiblePathElements.push('');
    let currentPath: string = cwd;

    for (const possiblePathElement of possiblePathElements) {
      // is this Dependency already on the list of things to install?
      let installModuleHere: boolean = true;
      for (const modulePath in optimalDependencyTargetFolder) {
        const modulesToBeInstalled: Array<DependencyRequestInfo> = optimalDependencyTargetFolder[modulePath];
        const matchingModule: DependencyRequestInfo = modulesToBeInstalled.find((moduleToBeInstalled: DependencyRequestInfo) => {
          return moduleToBeInstalled.identifier === requestedDependency.identifier;
        });

        if (matchingModule) {
          // tslint:disable-next-line:max-line-length
          logger.debug(`no need to install ${requestedDependency.identifier} to ${currentPath}. a matching version will already be installed to ${modulePath}`);
          installModuleHere = false;
          break;
        }
      }

      // Is a conflicting dependency-version already installed here?
      if (installModuleHere) {
        for (const installedDependency of alreadyInstalledDependencies) {
          if (installedDependency.name === requestedDependency.name &&
              installedDependency.location === path.join(currentPath, 'node_modules')) {
            // tslint:disable-next-line:max-line-length
            logger.debug(`${requestedDependency.identifier} can't be installed to ${currentPath}. it conflicts with the already installed ${installedDependency.name}@"${installedDependency.version}"`);
            installModuleHere = false;
            break;
          }
        }
      }

      // will any conflicting dependency-versions be installed here?
      if (installModuleHere && optimalDependencyTargetFolder[currentPath]) {
        const conflictingDependency: DependencyRequestInfo = optimalDependencyTargetFolder[currentPath]
          .find((toBeInstalledDependency: DependencyRequestInfo) => {
            return toBeInstalledDependency.name === requestedDependency.name &&
                  toBeInstalledDependency.versionRange !== requestedDependency.versionRange;
          });

        if (conflictingDependency) {
          // tslint:disable-next-line:max-line-length
          logger.debug(`${requestedDependency.identifier} can't be installed to ${currentPath}. it'd conflict with the to be installed ${conflictingDependency.identifier}`);
          installModuleHere = false;
        }
      }

      if (!installModuleHere) {
        currentPath = path.join(currentPath, possiblePathElement);
        continue;
      }

      logger.debug(`found a place to install ${requestedDependency.identifier}: ${currentPath}`);

      // the dependency can be installed here :)
      if (!optimalDependencyTargetFolder[currentPath]) {
        optimalDependencyTargetFolder[currentPath] = [];
      }

      optimalDependencyTargetFolder[currentPath].push(requestedDependency);
      break;
    }
  }

  return optimalDependencyTargetFolder;
}

function sortDependenciesByRequestCount(requestedDependencyArray: Array<DependencyRequestInfo>): Array<DependencyRequestInfo> {
  const result: Array<DependencyRequestInfo> = requestedDependencyArray
    .splice(0)
    .sort((dependency1: DependencyRequestInfo, dependency2: DependencyRequestInfo) => {
      return dependency1.requestedBy.length - dependency2.requestedBy.length;
    });

  return result;
}

function printNonOptimalDependencyInfos(requestedDependencies: DependencyRequests): void {
  let requestedDependencyArray: Array<DependencyRequestInfo> = dependenciesToArray(requestedDependencies);
  requestedDependencyArray = sortDependenciesByRequestCount(requestedDependencyArray);
  let initialMessagePrinted: boolean = false;

  for (const requestedDependencyName in requestedDependencies) {
    if (Object.keys(requestedDependencies[requestedDependencyName]).length <= 1) {
      continue;
    }

    if (!initialMessagePrinted) {
      logIfInRoot('┌---------------------------------------');
      logIfInRoot('| NON-OPTIMAL DEPENDENCY-SETUP DETECTED!');
      initialMessagePrinted = true;
    }

    // find the most requested version
    const requestedVersions: Array<DependencyRequestInfo> = requestedDependencyArray.filter((dependency: DependencyRequestInfo) => {
      return dependency.name === requestedDependencyName;
    });

    const mostRequested: DependencyRequestInfo = requestedVersions.splice(0, 1)[0];
    const requestedByOtherPackagesString: string = requestedVersions.map((requestedVersion: DependencyRequestInfo) => {
      const requestedByString: string = requestedVersion.requestedBy.map((requestedByPath: string) => {
        return `.${requestedByPath.substr(cwd.length)}`;
      }).join('\n|     ');

      return `
|   version ${requestedVersion.versionRange} satisfies ${requestedVersion.requestedBy.length} local modules:
|     ${requestedByString}`;
    }).join('\n| ');

  // tslint:disable:max-line-length
    logIfInRoot(`|
| ${mostRequested.requestedBy.length} local modules are satisfied with version ${mostRequested.versionRange} of ${mostRequested.name}, but some aren't:${requestedByOtherPackagesString}`);
  }
  // tslint:enable:max-line-length

  if (initialMessagePrinted) {
    logIfInRoot('└---------------------------------------');
    logIfInRoot(' ');
  } else {
    logIfInRoot('No suboptimal dependencies found');
  }
}

function printNonOptimalLocalModuleUsage(localModules: Array<ModuleInfo>, requestedDependencies: DependencyRequests): void {
  let requestedDependencyArray: Array<DependencyRequestInfo> = dependenciesToArray(requestedDependencies);
  requestedDependencyArray = sortDependenciesByRequestCount(requestedDependencyArray);
  let initialMessagePrinted: boolean = false;

  for (const requestedDependencyName in requestedDependencies) {
    const localVersionOfDependency: ModuleInfo = localModules.find((localModule: ModuleInfo) => {
      return localModule.name === requestedDependencyName;
    });

    // We don't need to warn about suboptimal local module usage, if the dependency
    // is not available as local module
    if (!localVersionOfDependency) {
      continue;
    }

    // find the most requested version
    const requestedWithIncompatibleVersion: Array<DependencyRequestInfo> = requestedDependencyArray.filter((dependency: DependencyRequestInfo) => {
      // if the name doesn't match then this is not a dependency we're looking for
      if (dependency.name !== localVersionOfDependency.name) {
        return false;
      }

      // if the local version satisfies the requested range, then this dependency is not incompatible
      if (semver.satisfies(localVersionOfDependency.version, dependency.versionRange)) {
        return false;
      }

      // At this point, the only at way for the dependency to be not incompatible,
      // is if the requested versionrange is not a valid semver range, and the
      // flag to assume that these are fulfilled is set
      if (assumeLocalModulesSatisfyNonSemverDependencyVersions === true && !semver.validRange(dependency.versionRange)) {
        return false;
      }

      // at this point we either have a valid but non-satisfied semver-range, or
      // an invalid semver-range while not assuming that local modules satisfy
      // these invalid ranges
      return true;
    });

    // if no conflicting version is requested, continue
    if (requestedWithIncompatibleVersion.length === 0) {
      continue;
    }

    if (!initialMessagePrinted) {
      logger.warn('THE FOLLOWING WILL BREAK YOUR INSTALLATION IF YOU RELY ON SINGLETONS!');
      logIfInRoot('┌-----------------------------------------');
      logIfInRoot('| NON-OPTIMAL LOCAL-MODULE-USAGE DETECTED!');
      initialMessagePrinted = true;
    }

    const requestedByOtherPackagesString: string = requestedWithIncompatibleVersion.map((requestedVersion: DependencyRequestInfo) => {
      const requestedByString: string = requestedVersion.requestedBy.map((requestedByPath: string) => {
        return `.${requestedByPath.substr(cwd.length)}`;
      }).join('\n|     ');

      return `
|   version ${requestedVersion.versionRange} is requested by ${requestedVersion.requestedBy.length} local modules:
|     ${requestedByString}`;
    }).join('\n| ');

    // tslint:disable:max-line-length
    logIfInRoot(`|
| you have version ${localVersionOfDependency.version} of ${localVersionOfDependency.name} localy, but some local modules request a different version:${requestedByOtherPackagesString}`);
    // tslint:enable:max-line-length
  }

  if (initialMessagePrinted) {
    logIfInRoot('└-----------------------------------------');
    logIfInRoot(' ');
  } else {
    logIfInRoot('No suboptimal local-module-usage found');
  }
}

async function removeContradictingInstalledDependencies(): Promise<Array<void>> {
  // remove all packages that contradict a modules package.json.
  // for example: module A requires B in version 2.0.0, and in
  // A/node_modules is a package B, but it is in version 1.0.0.
  // In that case, delete A/node_modules/B
  const {
    modules: localModules,
    installedDependencies: alreadyInstalledDependencies,
  } = await ModuleTools.getAllModulesAndInstalledDependenciesDeep();

  const deletionPromises: Array<Promise<void>> = [];

  for (const module of localModules) {
    for (const dependency in module.dependencies) {
      const requestedVersion: string = module.dependencies[dependency];
      const dependencyFolder: string = path.join(module.fullModulePath, 'node_modules');

      const matchingInstalledDependency: ModuleInfo = alreadyInstalledDependencies.find((installedDependency: ModuleInfo) => {
        return installedDependency.location === dependencyFolder && installedDependency.name === dependency;
      });

      // The requested dependency is not yet installed, so it can't contradict the version requested
      // in the package.json of the module
      if (matchingInstalledDependency === undefined || matchingInstalledDependency === null) {
        continue;
      }

      // The requested dependency is installed, but its version satisfied the version requested
      // in the package.json of the module, so we don't need to remove it.
      if (semver.satisfies(matchingInstalledDependency.version, requestedVersion)) {
        continue;
      }

      // The requested dependency is installed AND it does not satisfy the version requested
      // in the package.json of the module. We need to remove it!
      // tslint:disable-next-line:max-line-length
      logger.debug(`${module.name} wants ${dependency}@${requestedVersion}, but it has version ${matchingInstalledDependency.version} installed in its node_modules. Deleting the contradicting dependency!`);
      deletionPromises.push(SystemTools.delete(matchingInstalledDependency.fullModulePath));
    }
  }

  return Promise.all(deletionPromises);
}

async function findOptimalDependencyTargetFolder(): Promise<DependencyTargetFolder> {
  // create a list of places where dependencies should go. Remember to not install
  // dependencies that appear in the modules list, except when they won't be linked.

  const {
    modules: localModules,
    installedDependencies: alreadyInstalledDependencies,
  } = await ModuleTools.getAllModulesAndInstalledDependenciesDeep();

  // Find all dependencies of all modules in the requested versions
  let requestedDependencies: DependencyRequests = findRequestedDependencies(localModules);

  printNonOptimalDependencyInfos(requestedDependencies);
  printNonOptimalLocalModuleUsage(localModules, requestedDependencies);

  // remove all dependencies that are already satisfied by the current
  // installation or will be satisfied by linked local modules
  requestedDependencies = removeAlreadySatisfiedDependencies(requestedDependencies, localModules, alreadyInstalledDependencies);

  // now we know exactly what dependencies are missing where
  // next: calculate the optimal installation-folders, so that as few installs
  // as possible are done. The optimal folder is as close to the root folder
  // as possible without causing version conflicts within a folder.
  // To achieve this we start at the root-folder, and go deeper until we
  // find a folder that has no conflicting dependencies

  // First we make an array out of the requestedDependencies-object, so we
  // can sort the dependencies by the number of requests
  let requestedDependencyArray: Array<DependencyRequestInfo> = dependenciesToArray(requestedDependencies);
  requestedDependencyArray = sortDependenciesByRequestCount(requestedDependencyArray);

  return determineDependencyTargetFolder(requestedDependencyArray, alreadyInstalledDependencies);
}

async function fixMissingDependenciesWithSymlinks(): Promise<void> {

  const {
    modules: localModules,
    installedDependencies: installedDependencies,
  } = await ModuleTools.getAllModulesAndInstalledDependenciesDeep();

  const symlinkPromises: Array<Promise<void>> = [];

  for (const module of localModules) {
    for (const dependency in module.dependencies) {
      const requestedDependencyVersionRange: string = module.dependencies[dependency];
      // check if the dependency is already installed localy
      let dependencyAlreadyInstalled: boolean = false;
      let fittingInstalledModule: ModuleInfo = null;
      for (const installedModule of installedDependencies) {
        if (installedModule.name !== dependency) {
          continue;
        }

        if (installedModule.fullModulePath === path.join(module.fullModulePath, 'node_modules', installedModule.folderName)) {
          fittingInstalledModule = installedModule;
          dependencyAlreadyInstalled = true;
          break;
        } else if (semver.satisfies(installedModule.version, requestedDependencyVersionRange)) {
          fittingInstalledModule = installedModule;
        }
      }

      // when no installed module was found, see if a local module fits the dependency
      // but only if local modules are supposed to be linked
      // this overwrites otherwise found dependencies if they are not installed
      // directly in the modules node_modules-folder
      // in short, the order is: direct install > local module > indirect install
      if ((!fittingInstalledModule || !dependencyAlreadyInstalled) && linkModules) {
        for (const localModule of localModules) {

          const rangeIsValidAndSatisfied: boolean = semver.validRange(requestedDependencyVersionRange)
                                                 && semver.satisfies(localModule.version, requestedDependencyVersionRange);

          const rangeIsInvalidAndAssumedToBeSatisfied: boolean = !semver.validRange(requestedDependencyVersionRange)
                                                               && assumeLocalModulesSatisfyNonSemverDependencyVersions;

          const dependencyIsSatisfiedByLocalModule: boolean = rangeIsValidAndSatisfied || rangeIsInvalidAndAssumedToBeSatisfied;
          if (localModule.name !== dependency || !dependencyIsSatisfiedByLocalModule) {
            continue;
          }

          fittingInstalledModule = localModule;
          break;
        }
      }

      if (!dependencyAlreadyInstalled) {
        if (!fittingInstalledModule) {
          logger.error(`NO INSTALLATION FOUND FOR DEPENDENCY ${dependency} ON ${module.fullModulePath}. This shouldn't happen!`);
        } else {
          // simlink the dependency
          const sourceDependencyPath: string = fittingInstalledModule.fullModulePath;
          const targetDependencyPath: string = path.join(module.fullModulePath, 'node_modules', fittingInstalledModule.folderName);
          symlinkPromises.push(SystemTools.link(sourceDependencyPath, targetDependencyPath));

          // create all the .bin-symlinks
          // TODO: this won't work for packets that define a custom bin-folder.
          // This is so super-rare though, that it's not important for now
          for (const binEntry in fittingInstalledModule.bin) {
            const sourceFile: string = path.join(fittingInstalledModule.fullModulePath, fittingInstalledModule.bin[binEntry]);
            const targetLink: string = path.join(module.fullModulePath, 'node_modules', '.bin', binEntry);
            symlinkPromises.push(SystemTools.link(sourceFile, targetLink));
          }
        }
      }
    }
  }

  // tslint:disable-next-line:no-any
  return <Promise<any>> Promise.all(symlinkPromises);
}

function printInstallationStatus(startedInstallationCount: number, finishedInstallations: Array<number>): void {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  const installationStatus: Array<string> = [];
  for (let index: number = 0; index < startedInstallationCount; index++) {
    if (finishedInstallations.indexOf(index) >= 0) {
      installationStatus.push(`${index + 1}: ✓`);
    } else {
      // tslint:disable-next-line:no-multi-spaces
      installationStatus.push(`${index + 1}:  `);
    }
  }
  process.stdout.write(installationStatus.join(' '));
}

async function installModuleDependencies(): Promise<void> {

  await removeContradictingInstalledDependencies();
  const targets: DependencyTargetFolder = await findOptimalDependencyTargetFolder();

  // targets is an array where each entry has a location and a list of modules that should be installed
  const installPromises: Array<Promise<void>> = [];

  let startedInstallationCount: number = 0;
  const finishedInstallations: Array<number> = [];
  for (const targetFolder in targets) {

    const shortTargetFolder: string = `.${targetFolder.substr(process.cwd().length)}`;
    const installationIndex: number = startedInstallationCount;
    startedInstallationCount++;

    logIfInRoot(`${installationIndex + 1}. installing ${targets[targetFolder].length} dependencies to ${shortTargetFolder}`);
    installPromises.push(ModuleTools.installPackets(targetFolder, targets[targetFolder])
      .then(() => {
        finishedInstallations.push(installationIndex);
        printInstallationStatus(startedInstallationCount, finishedInstallations);
      }));
  }
  printInstallationStatus(Object.keys(targets).length, []);

  await Promise.all(installPromises);

  process.stdout.write('\n');

  // Now we're in a state where every dependency required by any local module
  // is installed at least somewhere. To make the modules find their dependencies
  // we now symlink them to the modules
  return fixMissingDependenciesWithSymlinks();

  // TODO: delete all unnecessary double-installs (when a and b both had a sub-dependency c that thus got installed twice)
  // this has low priority, as this is a rare edge-case with no real negative side-effects except a tiny bit bigger folder-size
}

async function runPostinstalls(): Promise<void> {
  const {modules: localModules} = await ModuleTools.getAllModulesAndInstalledDependenciesDeep();

  const postinstallPromises: Array<Promise<string>> = [];

  for (const module of localModules) {
    if (module.fullModulePath === cwd) {
      logger.debug('skipping the postinstall of the parent-module');
      continue;
    }

    if (!module.postinstallCommand) {
      logger.debug(`skipping the postinstall of ${module.name}. it has no postinstall script.`);
      continue;
    }

    logger.debug(`running postinstall of ${module.name}`);
    postinstallPromises.push(SystemTools.runCommand(`cd ${module.fullModulePath}${commandConcatSymbol} ${module.postinstallCommand}`));
  }

  // tslint:disable-next-line:no-any
  return <Promise<any>> Promise.all(postinstallPromises);
}

async function deleteLinkedLocalModules(): Promise<void> {
  const moduleInfos: ModulesAndDependenciesInfo = await ModuleTools.getAllModulesAndInstalledDependenciesDeep();

  // tslint:disable-next-line:no-any
  return <Promise<any>> Promise.all(moduleInfos.modules.map((moduleInfo: ModuleInfo) => {
    // local modules should be linked using the folder-names they should have,
    // no matter what folder-name they actually have, therefore don't use realFolderName here
    return SystemTools.delete(path.join(cwd, 'node_modules', moduleInfo.folderName));
  }));
}

function parseProcessArguments(): void {
  for (let i: number = 2; i < process.argv.length; i++) {
    if (process.argv[i].indexOf('--') !== 0) {
      ModuleTools.setModulesFolder(process.argv[i]);
    } else if (process.argv[i] === '--isChildProcess') {
      isInProjectRoot = false;
    } else if (process.argv[i] === '--loglevel') {
      logger.configure({level: process.argv[i + 1]});
      i++;
    } else if (process.argv[i] === '--no-link') {
      linkModules = false;
    } else if (process.argv[i] === '--cleanup') {
      cleanup = true;
    } else if (process.argv[i] === '--dependency-check-only') {
      dependencyCheckOnly = true;
    } else if (process.argv[i] === '--assume-local-modules-satisfy-non-semver-dependency-versions' || process.argv[i] === '--trust-local-modules') {
      assumeLocalModulesSatisfyNonSemverDependencyVersions = true;
    } else if (process.argv[i] === '--link-only') {
      linkOnly = true;
    } else if (process.argv[i] === '--no-hoist') {
      const noHoistEntry: Array<string> = process.argv[i + 1].split('@');
      noHoistList.push({
        name: noHoistEntry[0],
        versionRange: noHoistEntry[1],
        identifier: `${noHoistEntry[0]}@${noHoistEntry[1]}`,
      });

      i++;
    }
  }
}

async function cleanupDependencies(): Promise<void> {
  const moduleInfos: ModulesAndDependenciesInfo = await ModuleTools.getAllModulesAndInstalledDependenciesDeep();

  // tslint:disable-next-line:no-any
  return <Promise<any>> Promise.all(moduleInfos.modules.map((moduleInfo: ModuleInfo) => {
    // local modules should be linked using the folder-names they should have,
    // no matter what folder-name they actually have, therefore don't use realFolderName here
    return SystemTools.delete(path.join(moduleInfo.fullModulePath, 'node_modules'));
  }));
}

async function run(): Promise<void> {
  const startTime: number = Date.now();

  setupLogger();
  logger.configure({level: 'info'});
  parseProcessArguments();

  SystemTools.setLogger(logger);
  ModuleTools.setLogger(logger);

  logger.silly('process arguments:', process.argv);
  logger.silly('os platfrom:', os.platform());
  logger.debug('loglevel:', logger.level);
  logger.debug('isChildProcess:', !isInProjectRoot);
  if (os.platform() === 'win32') {
    commandConcatSymbol = '&';
    ModuleTools.setNullTarget('NUL');
    ModuleTools.setCommandConcatSymbol(commandConcatSymbol);
  }

  const pathParts: Array<string> = cwd.split(path.sep);
  projectFolderName = pathParts[pathParts.length - 1];
  logger.debug('project folder name:', projectFolderName);

  if (dependencyCheckOnly) {
    const {modules: localModules} = await ModuleTools.getAllModulesAndInstalledDependenciesDeep();

    const requestedDependencies: DependencyRequests = findRequestedDependencies(localModules);
    printNonOptimalDependencyInfos(requestedDependencies);
    printNonOptimalLocalModuleUsage(localModules, requestedDependencies);

    return;
  }

  if (linkOnly) {
    return fixMissingDependenciesWithSymlinks();
  }

  try {
    await checkStartConditions();
    if (linkModules) {
      await deleteLinkedLocalModules();
    }

    if (cleanup) {
      await cleanupDependencies();
    }

    await installModuleDependencies();
    await runPostinstalls();
    logIfInRoot(`\nminstall finished in ${SystemTools.getRuntime(startTime)} :)\n\n`);
  } catch (error) {
    if (error.constructor !== undefined && error.constructor.name === 'UncriticalError') {
      logIfInRoot(error.message);
    } else {
      throw error;
    }
  }
}

run();
