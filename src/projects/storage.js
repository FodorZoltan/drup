"use strict";

const yaml = require("node-yaml");
const path = require("path");
const fs = require("fs");

const globals = require("../globals");

let _storage;
function getStorage() {
  if (_storage) {
    return Promise.resolve(_storage);
  }

  return fs.exists(ProjectStorage.FILENAME)
    .then((exists) => {
      if (!exists) {
        return Promise.resolve({});
      }

      return yaml.read(ProjectStorage.FILENAME)
        .catch((err) => {
          throw new Error(`Failed loading in project storage file:\nFILE: ${Projects.STORAGE_FILE}\n` + err);
        });
    })
    .then((data) => {
      _storage = data;
      return data;
    });
}

class ProjectStorage {

  static get(key) {
    return getStorage()
      .then((storage) => {
        if (storage.hasOwnProperty(key)) {
          return null;
        }

        return {
          key: key,
          data: JSON.parse(JSON.stringify(storage[key])),
        };
      });
  }

  static getAll() {
    return getStorage()
      .then((storage) => {
        return JSON.parse(JSON.stringify(storage));
      });
  }

  static set(key, data) {
    return getStorage()
      .then((storage) => {
        storage[key] = data;

        return yaml.write(ProjectStorage.FILENAME, storage);
      })
      .catch((err) => {
        throw new Error(`Failed saving project storage when setting '${key}'.` + err);
      });
  }

  static remove(key) {
    return getStorage()
      .then((storage) => {
        if (storage.hasOwnProperty(key)) {
          delete storage[key];
          return yaml.write(ProjectStorage.FILENAME, storage);
        }

        return null;
      })
      .catch((err) => {
        throw new Error(`Failed saving project storage when removing '${key}'.` + err);
      });
  }

  static getByDirectory(dir) {
    dir = path.normalize(dir);

    return getStorage()
      .then((storage) => {
        for (const [key, data] of Object.entries(storage)) {
          if (data.root === dir) {
            return {
              key: key,
              data: JSON.parse(JSON.stringify(storage[key])),
            };
          }
        }

        return null;
      });
  }

}

ProjectStorage.FILENAME = path.join(globals.GLOBAL_STORE_ROOT, "projects.yml");

module.exports = ProjectStorage;