/* eslint-disable no-console */
import * as path from 'path';
import * as semver from 'semver';
import {intersect} from 'semver-intersect';
import * as logger from 'winston';

import {
  DependencyInfo,
  DependencyRequestInfo,
  DependencyRequests,
  DependencyTargetFolder,
  SemverRange,
} from './interfaces';
import {ModuleInfo} from './module_info';
import {ModuleTools} from './moduletools';
import {SystemTools} from './systools';
import {determineDependencyTargetFolder} from './target_folder_calculation';

const cwd: string = process.cwd();

export function findRequestedDependencies(localModules: Array<ModuleInfo>): DependencyRequests {
  const requestedDependencies: DependencyRequests = {};
  for (const module of localModules) {
    for (const [dependency, requestedVersion] of Object.entries(module.dependencies)) {
      if (requestedDependencies[dependency] === undefined) {
        requestedDependencies[dependency] = {};
      }

      let versionIsAlreadyRequestedByAModule = false;
      for (const version of Object.keys(requestedDependencies[dependency])) {
        let intersection: SemverRange = null;
        try {
          intersection = intersect(version, requestedVersion);
        } catch (error) {
          // the versions didn't intersect. That's ok!
          continue;
        }

        if (intersection !== version) {
          // the versions intersect at a different semver-range than the one that is already found,
          // so we update the old versionRange to the new one, so that the requested dependency
          // fits into that range.
          requestedDependencies[dependency][intersection] = requestedDependencies[dependency][version];
          delete requestedDependencies[dependency][version];
        }

        // now that we found a matching semver range for that dependency, add the module to the list of modules that request it
        requestedDependencies[dependency][intersection].push(module.fullModulePath);
        versionIsAlreadyRequestedByAModule = true;

        // we don't wan't that module to end up in multiple version-lists of that dependency
        break;
      }

      if (versionIsAlreadyRequestedByAModule) {
        continue;
      }

      if (requestedDependencies[dependency][module.dependencies[dependency]] !== undefined) {
        // the requested version wasn't found, but the exact version is already in the requested dependencies.
        // This means, that semver-intersect couldn't parse the version, which means it's not a semver-version
        requestedDependencies[dependency][module.dependencies[dependency]].push(module.fullModulePath);
      } else {
        // the requested version wasn't found, and the exact version is not yet in the requested dependencies.
        // This means that this module is the first one to request that dependency with that range
        requestedDependencies[dependency][module.dependencies[dependency]] = [
          module.fullModulePath,
        ];
      }
    }
  }

  return requestedDependencies;
}

function dependenciesToArray(dependencies: DependencyRequests): Array<DependencyRequestInfo> {
  const result: Array<DependencyRequestInfo> = [];

  for (const [dependencyName, requestedRanges] of Object.entries(dependencies)) {
    for (const [dependencyVersionRange, requestedBy] of Object.entries(requestedRanges)) {
      result.push({
        name: dependencyName,
        versionRange: dependencyVersionRange,
        identifier: `${dependencyName}@"${dependencyVersionRange}"`,
        requestedBy: requestedBy,
      });
    }
  }

  return result;
}

function sortDependenciesByRequestCount(requestedDependencyArray: Array<DependencyRequestInfo>): Array<DependencyRequestInfo> {
  const result: Array<DependencyRequestInfo> = requestedDependencyArray
    .splice(0)
    .sort((dependency1: DependencyRequestInfo, dependency2: DependencyRequestInfo) => {
      return dependency2.requestedBy.length - dependency1.requestedBy.length;
    });

  return result;
}

export function printNonOptimalDependencyInfos(requestedDependencies: DependencyRequests): void {
  let requestedDependencyArray: Array<DependencyRequestInfo> = dependenciesToArray(requestedDependencies);
  requestedDependencyArray = sortDependenciesByRequestCount(requestedDependencyArray);
  let initialMessagePrinted = false;

  for (const [requestedDependencyName, requestedDependencyRanges] of Object.entries(requestedDependencies)) {
    if (Object.keys(requestedDependencyRanges).length <= 1) {
      continue;
    }

    if (!initialMessagePrinted) {
      console.log('┌---------------------------------------');
      console.log('| NON-OPTIMAL DEPENDENCY-SETUP DETECTED!');
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
      })
        .join('\n|     ');

      return `
|   version ${requestedVersion.versionRange} satisfies ${requestedVersion.requestedBy.length} local modules:
|     ${requestedByString}`;
    })
      .join('\n| ');

    /* eslint-disable max-len */
    console.log(`|
| ${mostRequested.requestedBy.length} local modules are satisfied with version ${mostRequested.versionRange} of ${mostRequested.name}, but some aren't:${requestedByOtherPackagesString}`);
  }
  /* eslint-enable max-len */

  if (initialMessagePrinted) {
    console.log('└---------------------------------------');
    console.log(' ');
  } else {
    console.log('No suboptimal dependencies found');
  }
}

export function printNonOptimalLocalModuleUsage(
  localModules: Array<ModuleInfo>,
  requestedDependencies: DependencyRequests,
  assumeLocalModulesSatisfyNonSemverDependencyVersions: boolean,
): void {
  let requestedDependencyArray: Array<DependencyRequestInfo> = dependenciesToArray(requestedDependencies);
  requestedDependencyArray = sortDependenciesByRequestCount(requestedDependencyArray);
  let initialMessagePrinted = false;

  for (const requestedDependencyName of Object.keys(requestedDependencies)) {
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
      console.log('┌-----------------------------------------');
      console.log('| NON-OPTIMAL LOCAL-MODULE-USAGE DETECTED!');
      initialMessagePrinted = true;
    }

    const requestedByOtherPackagesString: string = requestedWithIncompatibleVersion.map((requestedVersion: DependencyRequestInfo) => {
      const requestedByString: string = requestedVersion.requestedBy.map((requestedByPath: string) => {
        return `.${requestedByPath.substr(cwd.length)}`;
      })
        .join('\n|     ');

      return `
|   version ${requestedVersion.versionRange} is requested by ${requestedVersion.requestedBy.length} local modules:
|     ${requestedByString}`;
    })
      .join('\n| ');

    /* eslint-disable max-len */
    console.log(`|
| you have version ${localVersionOfDependency.version} of ${localVersionOfDependency.name} localy, but some local modules request a different version:${requestedByOtherPackagesString}`);
    /* eslint-enable max-len */
  }

  if (initialMessagePrinted) {
    console.log('└-----------------------------------------');
    console.log(' ');
  } else {
    console.log('No suboptimal local-module-usage found');
  }
}

export async function removeContradictingInstalledDependencies(): Promise<Array<void>> {
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
    for (const [dependency, requestedVersion] of Object.entries(module.dependencies)) {
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
      // eslint-disable-next-line max-len
      logger.debug(`${module.name} wants ${dependency}@${requestedVersion}, but it has version ${matchingInstalledDependency.version} installed in its node_modules. Deleting the contradicting dependency!`);
      deletionPromises.push(SystemTools.delete(matchingInstalledDependency.fullModulePath));
    }
  }

  return Promise.all(deletionPromises);
}

function _handleInstalledModuleSatisfiesDependency(
  dependencyName: string,
  dependencyVersionRange: string,
  alreadyInstalledDependencies: Array<ModuleInfo>,
  remainingDependencies: DependencyRequests,
): void {

  // check if already installed modules satisfy the dependency
  for (const installedDependency of alreadyInstalledDependencies) {

    // if name or version of the installed dependency don't fit the requested dependency, then try the next installed dependency.
    if (dependencyName !== installedDependency.name) {
      continue;
    }

    if (!semver.satisfies(installedDependency.version, dependencyVersionRange)) {
      continue;
    }

    // an installed dependency that satisfies the request was found. Create debug logs that inform the user about that.
    for (const locationOfRequestingModule of remainingDependencies[dependencyName][dependencyVersionRange]) {
      const shortenedRequesterLocation: string = locationOfRequestingModule.substr(cwd.length);
      const shortenedInstalledLocation: string = installedDependency.location.substr(cwd.length);

      // eslint-disable-next-line max-len
      logger.debug(`dependency ${dependencyName}@${dependencyVersionRange} requested by '${shortenedRequesterLocation}' will be satisfied by installed version ${installedDependency.version} in '${path.join(shortenedInstalledLocation)}'`);
    }

    // remove the dependency from the list of unsatisfied dependencies
    // eslint-disable-next-line no-param-reassign
    delete remainingDependencies[dependencyName][dependencyVersionRange];
    break;
  }
}

function _handleLocalModuleSatisfiesDependency(
  dependencyName: string,
  dependencyVersionRange: string,
  localModules: Array<ModuleInfo>,
  assumeLocalModulesSatisfyNonSemverDependencyVersions: boolean,
  remainingDependencies: DependencyRequests,
): void {
  for (const localModule of localModules) {
    if (dependencyName !== localModule.name) {
      continue;
    }

    const rangeIsValidAndSatisfied: boolean = semver.validRange(dependencyVersionRange)
                                           && semver.satisfies(localModule.version, dependencyVersionRange);

    const rangeIsInvalidAndAssumedToBeSatisfied: boolean = !semver.validRange(dependencyVersionRange)
                                                         && assumeLocalModulesSatisfyNonSemverDependencyVersions;

    const dependencyIsSatisfiedByLocalModule: boolean = rangeIsValidAndSatisfied || rangeIsInvalidAndAssumedToBeSatisfied;
    if (!dependencyIsSatisfiedByLocalModule) {
      continue;
    }

    // a local dependency that satisfies the request was found. Create info and debug logs that inform the user about that.
    const shortenedLocalLocation = `.${localModule.location.substr(cwd.length)}`;
    const requesterLocations: Array<string> = remainingDependencies[dependencyName][dependencyVersionRange];
    const shortenedRequesterLocations: Array<string> = requesterLocations.map((locationOfRequestingModule: string) => {
      return `.${locationOfRequestingModule.substr(cwd.length)}`;
    });

    if (rangeIsInvalidAndAssumedToBeSatisfied) {
      // eslint-disable-next-line max-len
      logger.info(`Assuming that local module ${shortenedLocalLocation} satisfies ${dependencyName}@${dependencyVersionRange} requested by ${shortenedRequesterLocations.join(', ')}`);
    }

    for (const locationOfRequestingModule of remainingDependencies[dependencyName][dependencyVersionRange]) {
      const shortenedRequesterLocation = `.${locationOfRequestingModule.substr(cwd.length)}`;
      // eslint-disable-next-line max-len
      logger.debug(`dependency ${dependencyName}@${dependencyVersionRange} requested by '${shortenedRequesterLocation}' will be satisfied by local version ${localModule.version} in '${path.join(shortenedLocalLocation)}'`);
    }
    // eslint-disable-next-line no-param-reassign
    delete remainingDependencies[dependencyName][dependencyVersionRange];
    break;
  }
}

function removeAlreadySatisfiedDependencies(
  requestedDependencies: DependencyRequests,
  localModules: Array<ModuleInfo>,
  alreadyInstalledDependencies: Array<ModuleInfo>,
  linkModules: boolean,
  assumeLocalModulesSatisfyNonSemverDependencyVersions: boolean,
): DependencyRequests {

  const remainingDependencies: DependencyRequests = {...requestedDependencies};

  for (const [requestedDependencyName, requestedVersionRanges] of Object.entries(remainingDependencies)) {
    for (const requestedDependencyVersionRange of Object.keys(requestedVersionRanges)) {

      _handleInstalledModuleSatisfiesDependency(
        requestedDependencyName,
        requestedDependencyVersionRange,
        alreadyInstalledDependencies,
        remainingDependencies,
      );

      const dependencyIsAlreadySatisfied: boolean = requestedVersionRanges[requestedDependencyVersionRange] === undefined;
      const localModulesWontBeLinked = !linkModules;
      if (dependencyIsAlreadySatisfied || localModulesWontBeLinked) {
        continue;
      }

      // check if local modules that will get linked satisfy the dependency
      _handleLocalModuleSatisfiesDependency(
        requestedDependencyName,
        requestedDependencyVersionRange,
        localModules,
        assumeLocalModulesSatisfyNonSemverDependencyVersions,
        remainingDependencies,
      );
    }

    const allVersionsOfTheDependencyAreAlreadySatisfied: boolean = Object.keys(remainingDependencies[requestedDependencyName]).length === 0;
    if (allVersionsOfTheDependencyAreAlreadySatisfied) {
      delete remainingDependencies[requestedDependencyName];
    }
  }

  return remainingDependencies;
}

export async function findOptimalDependencyTargetFolder(
  linkModules: boolean,
  assumeLocalModulesSatisfyNonSemverDependencyVersions: boolean,
  noHoistList: Array<DependencyInfo>,
): Promise<DependencyTargetFolder> {
  // create a list of places where dependencies should go. Remember to not install
  // dependencies that appear in the modules list, except when they won't be linked.

  const {
    modules: localModules,
    installedDependencies: alreadyInstalledDependencies,
  } = await ModuleTools.getAllModulesAndInstalledDependenciesDeep();

  // Find all dependencies of all modules in the requested versions
  let requestedDependencies: DependencyRequests = findRequestedDependencies(localModules);

  printNonOptimalDependencyInfos(requestedDependencies);
  printNonOptimalLocalModuleUsage(localModules, requestedDependencies, assumeLocalModulesSatisfyNonSemverDependencyVersions);

  // remove all dependencies that are already satisfied by the current
  // installation or will be satisfied by linked local modules
  requestedDependencies = removeAlreadySatisfiedDependencies(
    requestedDependencies,
    localModules,
    alreadyInstalledDependencies,
    linkModules,
    assumeLocalModulesSatisfyNonSemverDependencyVersions,
  );

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

  return determineDependencyTargetFolder(requestedDependencyArray, alreadyInstalledDependencies, noHoistList);
}

function _findDirectlyInstalledDependency(targetModule: ModuleInfo, dependencyName: string, installedDependencies: Array<ModuleInfo>): ModuleInfo {
  return installedDependencies.find((installedDependency: ModuleInfo) => {
    if (installedDependency.name !== dependencyName) {
      return false;
    }

    const targetPath: string = path.join(targetModule.fullModulePath, 'node_modules', installedDependency.folderName);
    const dependencyIsInstalledDirectlyToModule: boolean = installedDependency.fullModulePath === targetPath;

    return dependencyIsInstalledDirectlyToModule;
  });
}

function _findLocalModuleAsDependency(
  dependencyName: string,
  requestedVersionRange: SemverRange,
  localModules: Array<ModuleInfo>,
  assumeLocalModulesSatisfyNonSemverDependencyVersions: boolean,
): ModuleInfo {
  return localModules.find((localModule: ModuleInfo) => {
    if (localModule.name !== dependencyName) {
      return false;
    }

    const rangeIsValidAndSatisfied: boolean = semver.validRange(requestedVersionRange)
                                           && semver.satisfies(localModule.version, requestedVersionRange);

    const rangeIsInvalidAndAssumedToBeSatisfied: boolean = !semver.validRange(requestedVersionRange)
                                                         && assumeLocalModulesSatisfyNonSemverDependencyVersions;

    const dependencyIsSatisfiedByLocalModule: boolean = rangeIsValidAndSatisfied || rangeIsInvalidAndAssumedToBeSatisfied;

    return dependencyIsSatisfiedByLocalModule;
  });
}

function _findInstalledDependency(
  targetModule: ModuleInfo,
  dependencyName: string,
  requestedVersionRange: SemverRange,
  installedDependencies: Array<ModuleInfo>,
): ModuleInfo {

  return installedDependencies.find((installedDependency: ModuleInfo) => {
    if (installedDependency.name !== dependencyName) {
      return false;
    }

    return semver.satisfies(installedDependency.version, requestedVersionRange);
  });
}

function _symlinkDependencyIntoModule(sourceDependency: ModuleInfo, targetModule: ModuleInfo): Array<Promise<void>> {
  const symlinkPromises: Array<Promise<void>> = [];

  // simlink the dependency
  const sourceDependencyPath: string = sourceDependency.fullModulePath;
  const targetDependencyPath: string = path.join(targetModule.fullModulePath, 'node_modules', sourceDependency.folderName);
  symlinkPromises.push(SystemTools.link(sourceDependencyPath, targetDependencyPath));

  // create all the .bin-symlinks
  // TODO: this won't work for packets that define a custom bin-folder.
  // This is so super-rare though, that it's not important for now
  for (const [commandName, filePath] of Object.entries(sourceDependency.bin)) {
    const sourceFile: string = path.join(sourceDependency.fullModulePath, filePath);
    const targetLink: string = path.join(targetModule.fullModulePath, 'node_modules', '.bin', commandName);
    symlinkPromises.push(SystemTools.link(sourceFile, targetLink));
  }

  return symlinkPromises;
}

export async function fixMissingDependenciesWithSymlinks(
  linkModules: boolean,
  assumeLocalModulesSatisfyNonSemverDependencyVersions: boolean,
): Promise<void> {

  const {
    modules: localModules,
    installedDependencies,
  } = await ModuleTools.getAllModulesAndInstalledDependenciesDeep();

  let symlinkPromises: Array<Promise<void>> = [];

  for (const module of localModules) {
    for (const [dependency, requestedDependencyVersionRange] of Object.entries(module.dependencies)) {

      // if the dependency is already installed directly into the modules node_modules, there is nothing left to do
      if (_findDirectlyInstalledDependency(module, dependency, installedDependencies) !== undefined) {
        continue;
      }

      let fittingInstalledModule: ModuleInfo;

      // if we are allowed to link local modules, see if one of them satisfies the dependency
      if (linkModules) {
        fittingInstalledModule = _findLocalModuleAsDependency(
          dependency,
          requestedDependencyVersionRange,
          localModules,
          assumeLocalModulesSatisfyNonSemverDependencyVersions,
        );
      }

      // if the dependency isn't directly installed, and no local module sastisfies it, see if a matching dependency is installed somewhere else
      if (fittingInstalledModule === undefined) {
        fittingInstalledModule = _findInstalledDependency(module, dependency, requestedDependencyVersionRange, installedDependencies);
      }

      if (fittingInstalledModule === undefined) {
        logger.error(`NO INSTALLATION FOUND FOR DEPENDENCY ${dependency} ON ${module.fullModulePath}. This shouldn't happen!`);
        continue;
      }

      symlinkPromises = symlinkPromises.concat(_symlinkDependencyIntoModule(fittingInstalledModule, module));
    }
  }

  await Promise.all(symlinkPromises);
}
