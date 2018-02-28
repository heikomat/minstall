# 3.3.0
### New Features
- new Flag `--no-hoist <dependency>`. Setting this makes minstall not hoist that
  dependency. `<dependecy>` has the form name@versionRange, e.g.
  `--no-hoist aurelia-cli@^0.30.1`. If you omit the versionRange, no version of
  that dependency will be hoisted. the name can be a glob expression (see
  [minimatch](https://www.npmjs.com/package/minimatch)), e.g.
  `--no-hoist aurelia-*`. This is useful for dependencies that don't play nice
  when hoisted/linked. This flag can be added multiple times.

# 3.2.0
### New Features
- new Flag `--assume-local-modules-satisfy-non-semver-dependency-versions` (aka
  `--trust-local-modules`). Setting this makes minstall assume that a local
  module satisfies every requested version of that module that is not valid
  semver (like github-urls and tag-names)

### Bugfixes
- Fixes a bug where in rare cases minstall was wrongfully printing error-messages about installed packages not being found
- Added a workaround to work around https://github.com/snyamathi/semver-intersect/issues/7
- If an error occurs during installation, then minstall will now actually fail with exit-code 1

### Improvements
minstall will now exit without doing anything when it detects that you're using
npm 5.7.0. That version of npm has a very serious bug, see https://github.com/npm/npm/issues/19883

# 3.1.0
### New Features
- new `--link-only`-flag (makes minstall fix all linked dependencies (including links to local modules))

### Bugfixes
Minstall will now no longer try to hoist non-semver-dependencies, as minstall wouldn't be able to find them after the installation

### Improvements
The error-message when a package.json couldn't be parsed now includes the location of said package.json

# 3.0.4
### Bugfix
Minstall now no longer wrongully detects prerelease-versions as incompatible (Issue [#31](https://github.com/heikomat/minstall/issues/31))

# 3.0.3
### Improvements
Add support to use local modules within the parent-module itself (add
the local modules to the peerDependencies)

# 3.0.2
### Improvements
Update Readme-example for 3.0.x

# 3.0.1
### Improvements
fix a small typo in suboptimal-dependency-logs

# 3.0.0
### New Features
- new `--cleanup`-flag (makes minstall remove all node_modules-folders before installing dependencies)
- new `--dependency-check-only`-flag (makes install print the dependency-check only, without touching any files or installing anything)
- optimized detection of optimal dependency-installation-folder
- npm5-support through optimized dependency installation and forced `--cleanup`-flag
- parallel installation of conflicting dependencies

### Improvements
minstall 3 is way faster than minstall 2 because of better detection of optimized
dependency installation, parallel installation of conflicting dependencies and
npm5 support.

### Breaking changes
minstall now works completely different to version 2.0.0. Before you needed to
add minstall as postinstall to every level of local modules. Now only the
parent-project needs the minstall-postinstall.

**before:**

modules are found in parent-folders through node-module resolution
```
my-modular-app
├── modules
│   ├── database (@2.0.0) [requires abc@2.0.0 and tasks]
│   ├── tasks (@2.0.0) [requires abc@1.0.0, xyz, which in return requires database@1.0.0]
│   │   └── node_modules
│   │       └── abc@1.0.0
│   ├── test1(@2.0.0) [requires abc@1.0.0]
│   │   └── node_modules
│   │       └── abc@1.0.0
│   └── test2(@2.0.0) [requires abc@2.0.0]
├── node_modules
│   ├── abc@2.0.0
│   ├── minstall
│   ├── database ../modules/database
│   └── tasks -> ../modules/tasks
├── index.js
└── package.json [requires minstall, database@2.0.0 and tasks@2.0.0]
```

**now:**

the correct versions of the dependency are installed once and linked to the
destinations. in this example, abc@1.0.0 and abc@2.0.0 are only installed once,
while abc@1.0.0 would've been installed twice with minstall 2.0.2
```
my-modular-app
├── modules
│   ├── database (@2.0.0) [requires abc@2.0.0 and tasks]
│   │   └── node_modules
│   │       └── abc -> ../../../node_modules/abc
│   │       └── tasks -> ../../tasks
│   ├── tasks (@2.0.0) [requires abc@1.0.0, xyz, which in return requires database@1.0.0]
│   │   └── node_modules
│   │       ├── abc@1.0.0
│   │       ├── database@1.0.0
│   │       └── xyz
│   ├── test1 (@2.0.0) [requires abc@1.0.0]
│   │   └── node_modules
│   │       └── abc -> ../../tasks/node_modules/abc [<- NOT REINSTALLED, BUT LINKED!]
│   └── test2 (@2.0.0) [requires abc@2.0.0]
│       └── node_modules
│           └── abc -> ../../../node_modules/abc
├── node_modules
│   ├── abc@2.0.0
│   └── minstall
├── index.js
└── package.json [requires minstall, database@2.0.0 and tasks@2.0.0]
```

# 2.0.2
### Bugfixes
- Minstall now uses the folder name a local module should have according to the modules name
  to link it to node_modules, instead of its actual folder name ([#26](https://github.com/heikomat/minstall/pull/26))

# 2.0.1
### Improvements
- As of npm 5, npm automatically `--save`s dependencies installed with `npm install`.
  because minstall shouldn't touch the local modules package.json files, this change adds
  the `--no-save` flag the internaly used `npm install` command

# 2.0.0
### Bugfixes
- Fix linking of localy available packages, when they are also a sub-dependency (see below)

### Breaking changes
This breaking change applies **only** to the following scenario:
- linking is not disabled
- at some point somewhere you have a dependency on package xyz
- xyz has a (sub-)dependency on a package, that is actually localy avaliable (regardless of the version)

**before:**

That sub-dependency gets installed from the registry to the main node_modules
```
my-modular-app
├── modules
│   ├── database (@2.0.0)
│   └── tasks (@2.0.0) [requires xyz, which in return requires database@^1.0.0]
├── node_modules
│   ├── minstall
│   ├── database (@1.0.0 from registry)
│   └── tasks -> ../modules/tasks
├── index.js
└── package.json [requires minstall, database@2.0.0 and tasks@2.0.0]
```

**now (if linking is enabled):**

The localy avaliable package will be linked in the main node_modules
```
my-modular-app
├── modules
│   ├── database (@2.0.0)
│   └── tasks (@2.0.0) [requires xyz, which in return requires database@1.0.0]
├── node_modules
│   ├── minstall
│   ├── database ../modules/database
│   └── tasks -> ../modules/tasks
├── index.js
└── package.json [requires minstall, database@2.0.0 and tasks@2.0.0]
```

notice how before, database@1.0.0 was installed, but the local package not linked, and now
the local package is linked, but database@1.0.0 not installed.

The reasoning is, that when linking packages, you usually do that for development purposes,
but without that change, some localy avaliable packages might not get linked


# 1.6.1
### Improvements
- Better install-as-dependency detection
- Better compatibility for modules as dependencies, that have local packages with the same names as local packages from the parent
- Improved cleanup after install-as-dependency
- Better support for scoped-packages on install-as-dependency

# 1.6.0
### New Features
- added `--no-link` and `--loglevel` flags

# 1.5.0
### New Features
- Support for local modules as dependencies in other local modules.
  aka. if your local module A requires your local module B, B wont be downloaded, but linked, if the local version of B matches A's dependency
- Minstall now allows `.` as module-folder
  for when you just want to install and link a bunch of modules, that don't have a parent-project (this is experimental, please open an issue if this feature leads to problems)

### Bugfixes
- Fix handling of scoped local modules
- local scoped modules are now linked using their scoped-names, no matter what the folder they are actually in is called

### Improvements
- Updated the version of fs-extra minstall uses to 2.0.0
- some code cleanup

# 1.4.0
### Bugfixes
- Fix installing a package as dependency with minstall-postinstall (see #16)

# 1.3.7
### Bugfixes
- Fix already linked modules from a previous installation not being deleted before reinstall

### Improvements
- Add stdout-log to output when a command from within minstall fails

# 1.3.6
### Bugfixes
- Fix installing of conflicting scoped dependencies

# 1.3.3
### Bugfixes
- Fix wrong module-folder usage

# 1.3.2
### Improvements
- Greatly improve logs. npm-warnings are now silenced (errors are still shown though)

# 1.3.1
### New Features
- **minstall now installs conflicting dependencies correctly**, but gives a hint that the user might try to use non-conflicting package-versions
- minstall now better detects, when it's started from the wrong folder, and exits without doing anything

### Bugfixes
- through the use of fs-extra instead of fs, the filesystem-operations are now easier and less prone to error

### Improvements
- Code cleanup

# 1.2.0
### Improvements
- minstall will now throw an error and exit, if it detects incompatible versions of the same dependency
- Code cleanup
- use of the 5minds-eslint-styleguides instead of these from airbnb

# 1.1.0
### Improvements
- Module-installation (especially for large projects) is now a lot faster
- Running the script in a project-folder, that is already installed is now a lot faster
- The whole code got refactored and cleaned up
- Some logs are a little nicer

# 1.0.8
### New Features
- added `modules-folder`-argument

### Bugfixes
- when verifying folder names, a non-existing folder is now considered unverified, instead of throwing an error

### Improvements
- Messages, for when there is nothing to do for minstall look like nice exit-messages now, instead of like errors
