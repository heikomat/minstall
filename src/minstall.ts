#!/usr/bin/env node

import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import * as semver from 'semver';
import * as winston from 'winston';
import {inspect} from 'util';
import {SPLAT} from 'triple-beam';

import {
  findOptimalDependencyTargetFolder,
  findRequestedDependencies,
  fixMissingDependenciesWithSymlinks,
  printNonOptimalDependencyInfos,
  printNonOptimalLocalModuleUsage,
  removeContradictingInstalledDependencies,
} from './dependency_handling';
import {
  DependencyInfo, DependencyRequests, DependencyTargetFolder, ModulesAndDependenciesInfo,
} from './interfaces';
import {ModuleInfo} from './module_info';
import {ModuleTools} from './moduletools';
import {SystemTools} from './systools';
import {UncriticalError} from './uncritical_error';

let logger: winston.Logger;
const setupLogger = () => {
  const logLevels = {
    critical: {level: 0, color: 'red'},
    error: {level: 1, color: 'magenta'},
    warn: {level: 2, color: 'yellow'},
    info: {level: 3, color: 'green'},
    verbose: {level: 4, color: 'gray'},
    debug: {level: 5, color: 'blue'},
    silly: {level: 6, color: 'cyan'},
  };

  const levels = {};
  const colors = {};
  for (const [name, level] of Object.entries(logLevels)) {
    levels[name] = level.level;
    colors[name] = level.color;
  }

  const isPrimitive = (value) => {
    return value === null || (typeof value !== 'object' && typeof value !== 'function');
  };

  const formatWithInspect = (value) => {
    const prefix = isPrimitive(value) ? '' : '\n';
    const shouldFormat = typeof value !== 'string';
    return prefix + (shouldFormat ? inspect(value, {depth: null, colors: true}) : value);
  };

  logger = winston.createLogger({
    levels: levels,
    transports: [
      new winston.transports.Console({
        stderrLevels: ['warn', 'error', 'critial'],
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.prettyPrint(),
          winston.format.simple(),
          winston.format.printf((info) => {
            const msg = formatWithInspect(info.message);
            const splatArgs = info[SPLAT] || [];
            const rest = splatArgs.map((data) => { return formatWithInspect(data); })
              .join(' ');

            return `${info.timestamp} - ${info.level}: ${msg} ${rest}`;
          }),
        ),
        handleExceptions: true,
      }),
    ],
  });
  winston.add(logger);
};

const cwd: string = process.cwd();

let commandConcatSymbol = ';';
let localPackage: ModuleInfo = null;

let installedAsDependency = false;
let projectFolderName: string = null;
let linkModules = true;
let npmVersion: string = null;
let cleanup = false;
let dependencyCheckOnly = false;
let linkOnly = false;
let isInProjectRoot = true;
let assumeLocalModulesSatisfyNonSemverDependencyVersions = false;
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

async function _checkNpmVersion(): Promise<void> {
  npmVersion = await SystemTools.runCommand('npm --version', true);
  if (semver.satisfies(npmVersion, '5.7.0')) {
    logger.error('You\'re using npm 5.7.0. Do not use this version, it has a critical bug that is fixed in 5.7.1. See npm-issue #19883 for more info');
    process.exit(1);
  }

  // npm 5 workaround until npm-issue #16853 is fixed. replace the if-confition
  // and log when some npm version is confirmed working without that workaround.
  // even 5.7.1 is not working correctly without that workaround
  // if (semver.satisfies(npmVersion, '>=5.0.0 <5.7.0')) {
  const buggyNpmVersion = 5;
  if (semver.major(npmVersion) === buggyNpmVersion) {
    // logger.info('npm >=5.0.0 <5.7.0 detected. forcing --cleanup');
    logger.info('npm 5 detected. forcing --cleanup');
    cleanup = true;
  }
}

async function checkStartConditions(): Promise<void> {
  logger.debug('checking start conditions');

  await _checkNpmVersion();

  const pathParts: Array<string> = cwd.split(path.sep);
  let parentFolder: string;

  localPackage = await getLocalPackageInfo();
  if (!localPackage.isScoped) {
    const parentFolderIndexDifference = 2;
    parentFolder = pathParts[pathParts.length - parentFolderIndexDifference];
  } else {
    const scopedParentFolderIndexDifference = 3;
    parentFolder = pathParts[pathParts.length - scopedParentFolderIndexDifference];
  }

  if (parentFolder === 'node_modules') {
    logger.debug('project is in a node_modules folder. It\'s therefore installed as a dependency');
    installedAsDependency = true;
  }

  let folderName: string = await SystemTools.verifyFolderName(cwd, 'node_modules');
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

  isInProjectRoot = !await SystemTools.isSymlink(path.join(cwd, 'node_modules'));

  if (!localPackage.dependencies.minstall) {
    throw new UncriticalError('minstall started from outside the project-root. aborting.');
  }
}

function printInstallationStatus(startedInstallationCount: number, finishedInstallations: Array<number>): void {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  const installationStatus: Array<string> = [];
  for (let index = 0; index < startedInstallationCount; index++) {
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
  const targets: DependencyTargetFolder = await findOptimalDependencyTargetFolder(
    linkModules,
    assumeLocalModulesSatisfyNonSemverDependencyVersions,
    noHoistList,
  );

  // targets is an array where each entry has a location and a list of modules that should be installed
  const installPromises: Array<Promise<void>> = [];

  let startedInstallationCount = 0;
  const finishedInstallations: Array<number> = [];
  for (const targetFolder in targets) {

    const shortTargetFolder = `.${targetFolder.substr(cwd.length)}`;
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
  return fixMissingDependenciesWithSymlinks(linkModules, assumeLocalModulesSatisfyNonSemverDependencyVersions);

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
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].indexOf('--') !== 0) {
      ModuleTools.setModulesFolder(process.argv[i]);
    } else if (process.argv[i] === '--loglevel') {
      // tslint:disable-next-line:no-any
      (<any> logger).level = process.argv[i + 1];
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
  // tslint:disable-next-line:no-any
  (<any> logger).level = 'info';
  parseProcessArguments();

  logger.silly('process arguments:', process.argv);
  logger.silly('os platfrom:', os.platform());
  logger.debug('loglevel:', logger.level);
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
    printNonOptimalLocalModuleUsage(localModules, requestedDependencies, assumeLocalModulesSatisfyNonSemverDependencyVersions);

    return;
  }

  if (linkOnly) {
    return fixMissingDependenciesWithSymlinks(linkModules, assumeLocalModulesSatisfyNonSemverDependencyVersions);
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
