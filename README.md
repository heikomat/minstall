Minstall is a local module installer, intended to be used as postinstall-script.

## Example
Let's say you have the following modular app, and run `npm install` on it:
```
my-modular-app
├── modules
│   ├── database
│   │   ├── index.js
│   │   └── package.json [requires mongoose and lodash]
│   └── tasks
│       ├── index.js
│       └── package.json [requires lodash and database]
├── index.js
└── package.json [requires express, uses database and tasks]
```

#### The problems
- Your local modules (`database` and `tasks`) wouldn't work, because their dependencies are missing.
- To require your modules, you would need to either npm-link them, or use a `./modules/`-prefix

#### The solution
Minstall installs the necessary dependencies to the root-`node_modules`, and symlinks the modules there.
After running `npm install` with minstall as postinstall, the structure looks like this:
```
my-modular-app
├── modules
│   ├── database
│   │   ├── index.js
│   │   ├── node_modules
│   │   │   ├── lodash -> ../../../node_modules/lodash
│   │   │   └── mongoose -> ../../../node_modules/mongoose
│   │   └── package.json
│   └── tasks
│   │   ├── index.js
│   │   ├── node_modules
│   │   │   └── lodash -> ../../../node_modules/lodash
│   │   │   └── database -> ../../database
│   │   └── package.json
├── node_modules
│   ├── lodash
│   ├── minstall
│   └── mongoose
├── index.js
└── package.json
```
- All modules work, because their dependencies are present
  - conflicting dependencies end up in the associated modules, not in the root
- Modules can be required directly, because they are symlinked
  - ~~`require('./modules/database')`~~ -> `require('database')`
- The installation is faster and smaller, because dependencies are only installed once
  - dependencies that are already installed, are not re-downloaded
    (except for npm5 users, because of npm issue [#16853](https://github.com/npm/npm/issues/16853))


## Usage
- install with `npm install minstall --save`
- add it as postinstall-script to your package.json:
- `modules-folder` is optional, and defaults to `modules` if omitted
```JavaScript
"scripts": {
  "postinstall": "minstall <modules-folder>"
}
```

## Parameters
Minstall knows the following flags:
- `--no-link` prevents minstall from linking the local modules to the root-node_modules
- `--link-only` makes minstall go through the linking-process only, without installing anything
- `--cleanup` makes minstall remove all node_modules-folders before installing dependencies (this is forced for npm5)
- `--dependency-check-only` makes install print the dependency-check only, without touching any files or installing anything
- `--assume-local-modules-satisfy-non-semver-dependency-versions` (aka `--trust-local-modules`) makes minstall assume that a local module satisfies every requested version of that module that is not valid semver (like github-urls and tag-names)
- `--loglevel <loglevel>` sets the loglevel (`error`, `warn`, `info` `verbose`, `debug`, `silly`)
- `--no-hoist <dependency>`. makes minstall not hoist that dependency. `<dependecy>` has the form name@versionRange, e.g. `--no-hoist aurelia-cli@^0.30.1`. If you omit the versionRange, no version of that dependency will be hoisted. the name can be a glob expression (see [minimatch](https://www.npmjs.com/package/minimatch)), e.g. `--no-hoist aurelia-*`. This is useful for dependencies that don't play nice when hoisted/linked.

## In collaboration with

![5Minds IT-Solutions](img/5minds_logo.png "5Minds IT-Solutions")

#### [5minds.de](https://5minds.de)

#### [github.com/5minds](https://github.com/5minds)
