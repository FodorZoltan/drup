"use strict";

const inquirer  = require("inquirer");
const yaml = require($SRC + "yaml");
const utils = require("../utils");
const annotatedLoader = require("../ann_loader");
const fs = require("fs-promise");
const path = require("path");

const ServiceCollection = require("./service_collection");
const OperationCollection = require("../operation_collection");
const PromiseEventEmitter = require("../promise-emmiter");

const EError = require("../eerror");

// Required configuration keys with validation function.
const requiredConfig = {

};

/**
 * Contains available container handlers.
 * @type {ContainerBase[]}
 */
let containers;

/**
 * Collects and returns the available containers.
 *
 * @returns {ContainerBase[]}
 */
function getContainerTypes() {
  if (!containers) {
    containers = annotatedLoader.collectClasses(__dirname + "/containers", "Container","id");
  }

  return containers;
}

/**
 * Environment handler class.
 */
class Environment extends PromiseEventEmitter {

  /**
   * Environment constructor.
   *
   * @param {string} id
   *    The environment unique ID.
   * @param {Object|ServiceCollection} servicesConfig
   *    Available services with their configurations.
   * @param {Object} config
   *    Configuration like 'host_alias' and other that will
   *    be added to the env file.
   * @param {string} root
   *    The root directory of the environment.
   */
  constructor(id, servicesConfig, config, root) {
    // Init the event emitter.
    super();

    if (!root) {
      throw new Error("Environment root parameter is required.");
    }

    // Make sure this ID is as simple as possible and it still
    // complies to docker compose container prefix.
    if (!id.match(/^[a-z][a-z0-9]*$/)) {
      throw new Error(`Malformed environment ID: '${id}'`);
    }

    this._servicesInitialized = false;

    this._services = servicesConfig;
    this._id = id;
    this.config = config;
    this.root = root;
  }

  /**
   * Create new environment configuration.
   *
   * @param {string} id
   *    ID of the environment.
   * @param {EnvironmentConfigurator} envConfigurator
   *    Service configurator.
   * @param {Object} config
   *    Additional config to be stored with environment.
   * @param {string} root
   *    The root directory for the environment.
   *
   * @returns {Promise.<Environment>}
   * @resolve {Environment}
   */
  static create(id, envConfigurator, config, root) {
    // Validate required additional configuration.
    for (const [name, validate] of Object.entries(requiredConfig)) {
      if (!config.hasOwnProperty(name)) {
        throw Error(`'${name}' configuration value is required for environment.`);
      }

      if (!validate(config[name])) {
        throw Error(`'${name}' configuration value is invalid: '${config[name]}'`);
      }
    }

    // Configure and create the environment object.
    return envConfigurator.configure().then((services) => {
      return new Environment(id, services, config, root);
    });
  }

  /**
   * Reconfigures the environment.
   *
   * This allows modifying service settings or adding/removing services.
   *
   * @param {EnvironmentConfigurator} envConfigurator
   *   The environment configurator.
   * @param {string} containerType
   *   The container type to compile.
   *
   * @returns {Promise.<Environment>}
   */
  reConfigure(envConfigurator, containerType = "*") {
    return envConfigurator.setDefaults(this.services.getConfigurations())
      .configure().then((services) => {
        // Prevent old service objects from interacting with the environment.
        this._services.each((service) => this.unbindObserver(service));

        this._servicesInitialized = false;
        this._services = services;
      })
      .then(() => this.compile(containerType))
      .then(() => this.save(this._configInProject));
  }

  /**
   * Load environment from configuration.
   *
   * @param {string} id
   *    ID of the environment.
   * @param {Object} config
   *    The environment config.
   * @param {string} root
   *    Root directory of the environment.
   *
   * @returns {Promise.<Environment>}
   * @resolve {Environment}
   */
  static load(id, config, root) {
    let configPath = root;
    let configInProject = false;

    // Try to read from root.
    return this.readConfig(configPath)
    // If failed to read from root try to read from root/project as the user
    // may choose to save in root or under the project to include in repo.
      .catch((err) => {
        // Other errors can happen, but we are only handling the not found.
        if (err.code !== "ENOENT") {
          throw err;
        }

        configInProject = true;
        configPath = path.join(root, Environment.DIRECTORIES.PROJECT);
        return this.readConfig(configPath);
      })
      .then((envConfig) => {
        let env = new Environment(id, envConfig.services, config, root);
        env.configFile = path.join(configPath, Environment.FILENAME);
        // In case we load in an environment we should never override it's
        // default configurations. To do so save the default config and
        // when saving check for these.
        env.configDefault = envConfig.config;
        env._configInProject = configInProject;

        return env;
      })
      .catch((err) => {
        throw new EError(`Failed instantiating environment from config.`).inherit(err);
      });
  }

  /**
   * Reads the environment configuration.
   *
   * @param root
   *    Root directory of the environment.
   *
   * @returns {Promise.<Object>}
   * @resolve {Object}
   *    Environment configuration object.
   */
  static readConfig(root) {
    root = path.join(root, Environment.FILENAME);

    return yaml.read(root)
      .catch((err) => {
        throw new EError(`Failed reading environment config:\nPATH: ${root}`).inherit(err);
      });
  }

  /**
   * Getter for the services.
   *
   * Provides lazy loading of the services classes.
   *
   * @returns {ServiceCollection}
   *    All the configured services.
   */
  get services() {
    // If the services were already initialized we are done.
    if (this._servicesInitialized) {
      return this._services;
    }

    this._servicesInitialized = true;

    // Services might be instantiated if we just got them from the configurator.
    // In that case prevent re-instantiation.
    if (!(this._services instanceof ServiceCollection)) {
      const availableServices = ServiceCollection.collect();
      const services = new ServiceCollection();

      for (let [id, serviceConfig] of Object.entries(this._services)) {
        // Services might become deprecated and removed. This prevents breaking.
        if (!availableServices.has(id)) {
          continue;
        }

        const Service = availableServices.get(id);
        const service = new Service(serviceConfig);

        services.addService(service);
      }
      this._services = services;
    }

    // Bind this environment to the services.
    this._services.each((service) => service.bindEnvironment(this));

    this.emit("servicesInitialized", this._services);
    return this._services;
  }

  /**
   * Check whether a directory has environment configuration.
   *
   * @param {string} directory
   *    The directory to check in.
   */
  static hasEnvironment(directory) {
    return fs.exists(path.join(directory, Environment.FILENAME));
  }

  /**
   * Get the ID of the environment.
   *
   * @returns {string}
   */
  getId() {
    return this._id;
  }

  /**
   * Gets service operations and detached operations.
   *
   * @param {string} projectType
   *    The type of project for which to get the operations.
   *
   * @return {OperationCollection}
   */
  getOperations(projectType) {
    // Get detached environment operations.
    const operations = new OperationCollection("Environment specific operations", __dirname + "/operations")
      .addPredefinedArgument(this);

    // Add all service operations.
    this.services.each((service, id) => {
      let dir = __dirname + "/services/" + id + "/operations";

      if (fs.existsSync(dir)) {
        operations.addFrom(dir);
      }
    });

    // Filter out project specific operations.
    return operations.filter((operation) => {
      return !operation.ann("types") || operation.ann("types").split(/[,.;\s]+/).includes(projectType);
    });
  }

  /**
   * Gets the primary mount directory of the project.
   *
   * @return {string|boolean}
   *   The path to the primary mount in containers otherwise false if none.
   */
  getProjectMountDirectory() {
    const web = this.services.firstOfGroup("web");
    if (web) {
      return web.getProjectMountPath();
    }

    return false;
  }

  /**
   * Save the environment configuration.
   *
   * @param includeInProject
   *    Whether to include the configuration in the project directory.
   *
   * @returns {Promise.<Environment>}
   * @resolve {self}
   */
  save(includeInProject = true) {
    includeInProject = includeInProject ? Environment.DIRECTORIES.PROJECT : "";
    const saveTo = path.join(this.root, includeInProject, Environment.FILENAME);

    let environment = {
      // Set the default configuration. If no default is available this
      // is a new environment, in that case the defaults will be the
      // current ones.
      config: this.configDefault || this.config,
      services: {},
    };

    this.services.each((service, id) => {
      environment.services[id] = service.config;
    });

    let promise = Promise.resolve();
    // Check if location of the configuration was just changed.
    if (this.configFile && this.configFile !== saveTo) {
      promise = fs.unlink(this.configFile)
        .catch((err) => {
          throw new EError("Failed removing old environment config file.").inherit(err);
        });
    }

    return promise.then(() => yaml.write(saveTo, environment))
      .catch((err) => {
        throw new EError("Failed to save environment configuration.").inherit(err);
      })
      .then(() => this);
  }

  /**
   * Compiles the environment as the provided container.
   *
   * @param {string} containerType
   *   The container type ID.
   *
   * @returns {Promise.<Environment>}
   */
  compile(containerType = "*") {
    return this.emitPromise("compileStarted")
      .then(() => {
        // If this is a new environment first create the directory structure.
        if (!this.configFile) {
          return this._createStructure();
        }

        // If this is an existing environment before re-compiling we should
        // remove all other config created before as certain services might be
        // removed.
        return this.emitPromise("reCompileStarted")
          .then(() => this.cleanDirectories());
      })
      .then(() => this.composeContainer(containerType))
      .then(() => this.writeServiceConfigFiles())
      .then(() => this.emit("compileFinished"))
      .then(() => this);
  }

  /**
   * Remove files from the env directories.
   *
   * @returns {Promise}
   */
  cleanDirectories() {
    let cleaning = [];

    Object.keys(Environment.DIRECTORIES).map((dirKey) => {
      // We keep the data because it contains sensitive files that might be
      // needed even after a re-compilation.
      if (!["DATA", "PROJECT"].includes(dirKey)) {
        cleaning.push(
          fs.emptyDir(path.join(this.root, Environment.DIRECTORIES[dirKey]))
          // Won't be able to remove all files as some of them are created
          // as root or different user then current UID.
            .catch(() => {})
        );
      }
    });

    return Promise.all(cleaning);
  }

  /**
   * Compose all or one container.
   *
   * @param {string} containerType
   *    Container handler ID. "*" will compose all containers.
   *
   * @returns {Promise.<ContainerBase|ContainerBase[]>}
   * @resolve {ContainerBase|ContainerBase[]}
   *    Container handler.
   */
  composeContainer(containerType) {
    if (containerType === "*") {
      let promises = [];

      for (let id of Object.keys(getContainerTypes())) {
        promises.push(this.composeContainer(id));
      }

      return Promise.all(promises);
    }

    let container = this.getContainer(containerType);
    let promise = Promise.resolve();

    // If the environment is new stop container before composing.
    if (this.configFile) {
      promise = promise.then(() => container.remove()).catch(() => {});
    }

    return promise.then(() => container.writeComposition())
      .then(() => container).catch((err) => {
        throw new EError(`Failed writing "${container.ann("id")}" container composition.`).inherit(err);
    });
  }

  /**
   * Get container handler for this environment.
   *
   * @param containerType
   *    Container handler ID.
   *
   * @returns {ContainerBase}
   */
  getContainer(containerType) {
    let containers = getContainerTypes();

    if (!containers[containerType]) {
      throw new Error(`Unknown container type: "${containerType}"`);
    }

    return new containers[containerType](this);
  }

  /**
   * Writes service configuration files.
   *
   * @returns {Promise}
   */
  writeServiceConfigFiles() {
    let promises = [];

    this.services.each((service) => {
      promises.push(service.writeConfigFiles(this.root));
    });

    // Allow services to implement fully custom reaction to the
    // generation of files.
    promises.push(this.emitPromise("writingConfigFiles"));

    return Promise.all(promises)
      .catch((err) => {
        throw new EError(`Failed creating configuration files for services.`).inherit(err);
      });
  }

  /**
   * Removes the specified container.
   *
   * @param {string} containerType
   *   The container type.
   *
   * @returns {Promise}
   */
  remove(containerType) {
    return this.getContainer(containerType).remove();
  }

  /**
   * Creates environment directory structure under root.
   *
   * @returns {Promise}
   * @private
   */
  _createStructure() {
    return fs.ensureDir(this.root).then(() => {
      return Promise.all(
        Object.keys(Environment.DIRECTORIES).map((dirKey) => {
          return fs.ensureDir(path.join(this.root, Environment.DIRECTORIES[dirKey]));
        })
      );
    });
  }

  /**
   * Gets host directory path of specified type.
   *
   * @param {string} type
   *   The directory type.
   *
   * @return {string}
   *   The host path.
   */
  getDirectoryPath(type = "PROJECT") {
    return path.join(this.root, Environment.DIRECTORIES[type]);
  }

  /**
   * Register event listener.
   *
   * In addition to parent returns self and validates callback.
   *
   * @param {...} args
   *   Arguments.
   *
   * @returns {Environment}
   */
  on(...args) {
    if (typeof args[1] !== "function") {
      throw new Error("Callback must be a function.");
    }
    super.on(...args);
    return this;
  }

}

// Environment configuration filename.
Environment.FILENAME = ".drup-env.yml";
// Directory names for the main structure.
Environment.DIRECTORIES = {
  CONFIG: "config",
  DATA: "data",
  LOG: "log",
  PROJECT: "project",
};

module.exports = Environment;
