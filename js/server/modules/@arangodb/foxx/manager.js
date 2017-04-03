'use strict';

// //////////////////////////////////////////////////////////////////////////////
// / @brief Foxx service manager
// /
// / @file
// /
// / DISCLAIMER
// /
// / Copyright 2013 triagens GmbH, Cologne, Germany
// /
// / Licensed under the Apache License, Version 2.0 (the "License")
// / you may not use this file except in compliance with the License.
// / You may obtain a copy of the License at
// /
// /     http://www.apache.org/licenses/LICENSE-2.0
// /
// / Unless required by applicable law or agreed to in writing, software
// / distributed under the License is distributed on an "AS IS" BASIS,
// / WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// / See the License for the specific language governing permissions and
// / limitations under the License.
// /
// / Copyright holder is triAGENS GmbH, Cologne, Germany
// /
// / @author Dr. Frank Celler
// / @author Michael Hackstein
// / @author Copyright 2013, triAGENS GmbH, Cologne, Germany
// //////////////////////////////////////////////////////////////////////////////

const fs = require('fs');
const path = require('path');
const querystringify = require('querystring').encode;
const dd = require('dedent');
const utils = require('@arangodb/foxx/manager-utils');
const store = require('@arangodb/foxx/store');
const FoxxService = require('@arangodb/foxx/service');
const generator = require('@arangodb/foxx/generator');
const ensureServiceExecuted = require('@arangodb/foxx/routing').routeService;
const arangodb = require('@arangodb');
const ArangoError = arangodb.ArangoError;
const errors = arangodb.errors;
const aql = arangodb.aql;
const db = arangodb.db;
const ArangoClusterControl = require('@arangodb/cluster');
const request = require('@arangodb/request');
const actions = require('@arangodb/actions');
const shuffle = require('lodash/shuffle');
const zip = require('lodash/zip');

const systemServiceMountPoints = [
  '/_admin/aardvark', // Admin interface.
  '/_api/foxx', // Foxx management API.
  '/_api/gharial' // General_Graph API.
];

const GLOBAL_SERVICE_MAP = new Map();

function warn (e) {
  let err = e;
  while (err) {
    console.warnLines(
      err === e
      ? err.stack
      : `via ${err.stack}`
    );
    err = err.cause;
  }
}

// Cluster helpers

function getAllCoordinatorIds () {
  if (!ArangoClusterControl.isCluster()) {
    return [];
  }
  return global.ArangoClusterInfo.getCoordinators();
}

function getMyCoordinatorId () {
  if (!ArangoClusterControl.isCluster()) {
    return null;
  }
  return global.ArangoServerState.id();
}

function getFoxmasterCoordinatorId () {
  if (!ArangoClusterControl.isCluster()) {
    return null;
  }
  return global.ArangoServerState.getFoxxmaster();
}

function getPeerCoordinatorIds () {
  const myId = getMyCoordinatorId();
  return getAllCoordinatorIds().filter((id) => id !== myId);
}

function parallelClusterRequests (requests) {
  const options = {coordTransactionID: global.ArangoClusterComm.getId()};
  let pending = 0;
  for (const [coordId, method, url, body, headers] of requests) {
    options.clientTransactionID = global.ArangoClusterInfo.uniqid();
    global.ArangoClusterComm.asyncRequest(
      method,
      `server:${coordId}`,
      db._name(),
      url,
      body ? (
        typeof body === 'string'
        ? body
        : JSON.stringify(body)
      ) : null,
      headers || {},
      options
    );
    pending++;
  }
  delete options.clientTransactionID;
  return ArangoClusterControl.wait(options, pending);
}

function isFoxxmasterReady () {
  if (!ArangoClusterControl.isCluster()) {
    return true;
  }
  const coordId = getFoxmasterCoordinatorId();
  const response = parallelClusterRequests([[
    coordId,
    'GET',
    '/_api/foxx/_local/status'
  ]])[0];
  return JSON.parse(response.body).ready;
}

function getChecksumsFromPeers (mounts) {
  const coordinatorIds = getPeerCoordinatorIds();
  const responses = parallelClusterRequests(function * () {
    for (const coordId of coordinatorIds) {
      yield [
        coordId,
        'GET',
        `/_api/foxx/_local/checksums?${querystringify({mounts})}`
      ];
    }
  }());
  const peerChecksums = new Map();
  for (const [coordId, response] of zip(coordinatorIds, responses)) {
    const body = JSON.parse(response.body);
    const coordChecksums = new Map();
    for (const mount of Object.keys(body)) {
      coordChecksums.set(mount, body[mount]);
    }
    peerChecksums.set(coordId, coordChecksums);
  }
  return peerChecksums;
}

// Startup and self-heal

function startup (fixMissingChecksums) {
  const db = require('internal').db;
  const dbName = db._name();
  try {
    db._useDatabase('_system');
    const databases = db._databases();
    for (const name of databases) {
      try {
        db._useDatabase(name);
        rebuildAllServiceBundles(fixMissingChecksums);
      } catch (e) {
        let err = e;
        while (err) {
          console.warnLines(
            err === e
            ? err.stack
            : `via ${err.stack}`
          );
          err = err.cause;
        }
      }
    }
  } finally {
    db._useDatabase(dbName);
  }
}

function rebuildAllServiceBundles (updateDatabase, fixMissingChecksums) {
  const servicesMissingChecksums = [];
  const collection = utils.getStorage();
  for (const serviceDefinition of collection.all()) {
    const mount = serviceDefinition.mount;
    if (mount.startsWith('/_')) {
      continue;
    }
    createServiceBundle(mount);
    if (fixMissingChecksums && !serviceDefinition.checksum) {
      servicesMissingChecksums.push({
        checksum: FoxxService.checksum(mount),
        _key: serviceDefinition._key
      });
    }
  }
  if (!servicesMissingChecksums.length) {
    return;
  }
  db._query(aql`
    FOR service IN ${servicesMissingChecksums}
    UPDATE service._key
    WITH {checksum: service.checksum}
    IN ${collection}
  `);
}

function selfHeal (healTheWorld) {
  const db = require('internal').db;
  const dbName = db._name();
  try {
    db._useDatabase('_system');
    const databases = db._databases();
    const foxxIsReady = isFoxxmasterReady();
    for (const name of databases) {
      try {
        db._useDatabase(name);
        if (healTheWorld) {
          healMyselfAndCoords();
        } else if (foxxIsReady) {
          healMyself();
        }
      } catch (e) {
        let err = e;
        while (err) {
          console.warnLines(
            err === e
            ? err.stack
            : `via ${err.stack}`
          );
          err = err.cause;
        }
      }
    }
  } finally {
    db._useDatabase(dbName);
  }
  reloadRouting(); // FIXME :(
}

function healMyself () {
  const servicesINeedToFix = new Map();

  const collection = utils.getStorage();
  for (const serviceDefinition of collection.all()) {
    const mount = serviceDefinition.mount;
    const checksum = serviceDefinition.checksum;
    if (mount.startsWith('/_')) {
      continue;
    }
    if (!checksum || checksum !== FoxxService.checksum(mount)) {
      servicesINeedToFix.set(mount, checksum);
    }
  }

  const coordinatorIds = getPeerCoordinatorIds();
  for (const [mount, checksum] of servicesINeedToFix) {
    const coordIdsToTry = shuffle(coordinatorIds);
    for (const coordId of coordIdsToTry) {
      const bundle = downloadServiceBundleFromCoordinator(coordId, mount, checksum);
      if (bundle) {
        replaceLocalServiceFromTempBundle(mount, bundle);
        break;
      }
    }
  }
}

function healMyselfAndCoords () {
  const checksumsINeedToFixLocally = [];
  const actualChecksums = new Map();
  const coordsKnownToBeGoodSources = new Map();
  const coordsKnownToBeBadSources = new Map();
  const allKnownMounts = [];

  const collection = utils.getStorage();
  for (const serviceDefinition of collection.all()) {
    const mount = serviceDefinition.mount;
    const checksum = serviceDefinition.checksum;
    if (mount.startsWith('/_')) {
      continue;
    }
    allKnownMounts.push(mount);
    actualChecksums.set(mount, checksum);
    coordsKnownToBeGoodSources.set(mount, []);
    coordsKnownToBeBadSources.set(mount, new Map());
    if (!checksum || checksum !== FoxxService.checksum(mount)) {
      checksumsINeedToFixLocally.push(mount);
    }
  }

  const serviceChecksumsByCoordinator = getChecksumsFromPeers(allKnownMounts);
  for (const [coordId, serviceChecksums] of serviceChecksumsByCoordinator) {
    for (const [mount, checksum] of serviceChecksums) {
      if (!checksum) {
        coordsKnownToBeBadSources.get(mount).set(coordId, null);
      } else if (!actualChecksums.get(mount)) {
        actualChecksums.set(mount, checksum);
        coordsKnownToBeGoodSources.get(mount).push(coordId);
      } else if (actualChecksums.get(mount) === checksum) {
        coordsKnownToBeGoodSources.get(mount).push(coordId);
      } else {
        coordsKnownToBeBadSources.get(mount).set(coordId, checksum);
      }
    }
  }

  const myId = getMyCoordinatorId();
  const serviceMountsToDeleteInCollection = [];
  const serviceChecksumsToUpdateInCollection = new Map();
  for (const mount of checksumsINeedToFixLocally) {
    const possibleSources = coordsKnownToBeGoodSources.get(mount);
    if (!possibleSources.length) {
      const myChecksum = FoxxService.checksum(mount);
      if (myChecksum) {
        serviceChecksumsToUpdateInCollection.set(mount, myChecksum);
        possibleSources.push(myId);
      } else {
        let found = false;
        for (const [coordId, coordChecksum] of coordsKnownToBeBadSources.get(mount)) {
          if (!coordChecksum) {
            continue;
          }
          serviceChecksumsToUpdateInCollection.set(mount, coordChecksum);
          possibleSources.push(coordId);
          const bundle = downloadServiceBundleFromCoordinator(coordId, mount, coordChecksum);
          replaceLocalServiceFromTempBundle(mount, bundle);
          found = true;
          break;
        }
        if (!found) {
          serviceMountsToDeleteInCollection.push(mount);
          coordsKnownToBeBadSources.delete(mount);
        }
      }
    } else {
      const checksum = actualChecksums.get(mount);
      for (const coordId of possibleSources) {
        const bundle = downloadServiceBundleFromCoordinator(coordId, mount, checksum);
        if (bundle) {
          replaceLocalServiceFromTempBundle(mount, bundle);
          break;
        }
      }
    }
  }

  for (const ids of coordsKnownToBeGoodSources.values()) {
    ids.push(myId);
  }

  db._query(aql`
    FOR service IN ${collection}
    FILTER service.mount IN ${serviceMountsToDeleteInCollection}
    REMOVE service
    IN ${collection}
  `);

  db._query(aql`
    FOR service IN ${collection}
    FOR item IN ${Array.from(serviceChecksumsToUpdateInCollection)}
    FILTER service.mount == item[0]
    UPDATE service
    WITH {checksum: item[1]}
    IN ${collection}
  `);

  parallelClusterRequests(function * () {
    for (const coordId of getPeerCoordinatorIds()) {
      const servicesYouNeedToUpdate = {};
      for (const [mount, badCoordinatorIds] of coordsKnownToBeBadSources) {
        if (!badCoordinatorIds.has(coordId)) {
          continue;
        }
        const goodCoordinatorId = coordsKnownToBeGoodSources.get(mount)[0]; // FIXME random
        servicesYouNeedToUpdate[mount] = goodCoordinatorId;
      }
      yield [
        coordId,
        'POST',
        '/_api/foxx/_local',
        JSON.stringify(servicesYouNeedToUpdate),
        {'content-type': 'application/json'}
      ];
    }
  }());
}

// Change propagation

function reloadRouting () { // TODO
  require('internal').executeGlobalContextFunction('reloadRouting');
  actions.reloadRouting();
}

function propagateServiceDestroyed (service) { // okay-ish
  parallelClusterRequests(function * () {
    for (const coordId of getPeerCoordinatorIds()) {
      yield [coordId, 'DELETE', `/_api/foxx/_local/service?${querystringify({
        mount: service.mount
      })}`];
    }
  }());
  reloadRouting(); // FIXME :(
}

function propagateServiceReplaced (service) { // okay-ish
  const myId = getMyCoordinatorId();
  parallelClusterRequests(function * () {
    for (const coordId of getPeerCoordinatorIds()) {
      yield [
        coordId,
        'POST',
        '/_api/foxx/_local',
        JSON.stringify({[service.mount]: myId}),
        {'content-type': 'application/json'}
      ];
    }
  }());
  reloadRouting(); // FIXME :(
}

function propagateServiceReconfigured (service) { // okay-ish
  parallelClusterRequests(function * () {
    for (const coordId of getPeerCoordinatorIds()) {
      yield [coordId, 'POST', `/_api/foxx/_local/service?${querystringify({
        mount: service.mount
      })}`];
    }
  }());
  reloadRouting(); // FIXME :(
}

// GLOBAL_SERVICE_MAP manipulation

function initLocalServiceMap () { // TODO
  const localServiceMap = new Map();

  for (const serviceDefinition of utils.getStorage().all()) {
    const service = FoxxService.create(serviceDefinition);
    localServiceMap.set(service.mount, service);
  }

  for (const mount of systemServiceMountPoints) {
    localServiceMap.set(mount, installSystemServiceFromDisk(mount));
    // FIXME this should probably happen in startup?
  }

  GLOBAL_SERVICE_MAP.set(db._name(), localServiceMap);
}

function ensureFoxxInitialized () {
  if (!GLOBAL_SERVICE_MAP.has(db._name())) {
    initLocalServiceMap();
  }
}

function ensureServiceLoaded (mount) {
  const service = getServiceInstance(mount);
  return ensureServiceExecuted(service, false);
}

function getServiceInstance (mount) {
  ensureFoxxInitialized();
  const localServiceMap = GLOBAL_SERVICE_MAP.get(db._name());
  if (localServiceMap.has(mount)) {
    return localServiceMap.get(mount);
  }
  return reloadInstalledService(mount);
}

function reloadInstalledService (mount, runSetup) {
  const serviceDefinition = utils.getServiceDefinition(mount);
  if (!serviceDefinition) {
    throw new ArangoError({
      errorNum: errors.ERROR_SERVICE_NOT_FOUND.code,
      errorMessage: dd`
        ${errors.ERROR_SERVICE_NOT_FOUND.message}
        Mount path: "${mount}".
      `
    });
  }
  const service = FoxxService.create(serviceDefinition);
  if (runSetup) {
    service.executeScript('setup');
  }
  GLOBAL_SERVICE_MAP.get(db._name()).set(mount, service);
  return service;
}

function installSystemServiceFromDisk (mount) {
  const options = utils.getServiceDefinition(mount);
  const service = FoxxService.create(Object.assign({mount}, options));
  const serviceDefinition = service.toJSON();
  db._query(aql`
    UPSERT {mount: ${mount}}
    INSERT ${serviceDefinition}
    REPLACE ${serviceDefinition}
    IN ${utils.getStorage()}
  `);
  return service;
}

// Misc?

function patchManifestFile (servicePath, patchData) {
  const filename = path.join(servicePath, 'manifest.json');
  let manifest;
  try {
    const rawManifest = fs.readFileSync(filename, 'utf-8');
    manifest = JSON.parse(rawManifest);
  } catch (e) {
    throw Object.assign(
      new ArangoError({
        errorNum: errors.ERROR_MALFORMED_MANIFEST_FILE.code,
        errorMessage: dd`
          ${errors.ERROR_MALFORMED_MANIFEST_FILE.message}
          File: ${filename}
        `
      }), {cause: e}
    );
  }
  Object.assign(manifest, patchData);
  fs.writeFileSync(filename, JSON.stringify(manifest, null, 2));
}

function _buildServiceInPath (serviceInfo, destPath, options = {}) { // okay-ish
  if (serviceInfo === 'EMPTY') {
    const generated = generator.generate(options);
    generator.write(destPath, generated.files, generated.folders);
  } else {
    if (/^GIT:/i.test(serviceInfo)) {
      const splitted = serviceInfo.split(':');
      const baseUrl = process.env.FOXX_BASE_URL || 'https://github.com';
      serviceInfo = `${baseUrl}${splitted[1]}/archive/${splitted[2] || 'master'}.zip`;
    } else if (/^uploads[/\\]tmp-/.test(serviceInfo)) {
      serviceInfo = path.join(fs.getTempPath(), serviceInfo);
    }
    if (/^https?:/i.test(serviceInfo)) {
      const tempFile = downloadServiceBundleFromRemote(serviceInfo);
      extractServiceBundle(tempFile, destPath, true);
    } else if (utils.pathRegex.test(serviceInfo)) {
      if (fs.isDirectory(serviceInfo)) {
        const tempFile = utils.zipDirectory(serviceInfo);
        extractServiceBundle(tempFile, destPath, true);
      } else if (!fs.exists(serviceInfo)) {
        throw new ArangoError({
          errorNum: errors.ERROR_SERVICE_SOURCE_NOT_FOUND.code,
          errorMessage: dd`
            ${errors.ERROR_SERVICE_SOURCE_NOT_FOUND.message}
            Path: ${serviceInfo}
          `
        });
      } else {
        extractServiceBundle(serviceInfo, destPath, false);
      }
    } else {
      if (options.refresh) {
        try {
          store.update();
        } catch (e) {
          warn(e);
        }
      }
      const info = store.installationInfo(serviceInfo);
      const tempFile = downloadServiceBundleFromRemote(info.url);
      extractServiceBundle(tempFile, destPath, true);
      patchManifestFile(destPath, info.manifest);
    }
  }
  if (options.legacy) {
    patchManifestFile(destPath, {engines: {arangodb: '^2.8.0'}});
  }
}

function _install (serviceInfo, mount, options = {}) { // WTF?
  const servicePath = FoxxService.basePath(mount);
  if (fs.exists(servicePath)) {
    throw new ArangoError({
      errorNum: errors.ERROR_SERVICE_MOUNTPOINT_CONFLICT.code,
      errorMessage: dd`
        ${errors.ERROR_SERVICE_MOUNTPOINT_CONFLICT.message}
        Mount path: "${mount}".
      `
    });
  }
  fs.makeDirectoryRecursive(path.dirname(servicePath));
  // Remove the empty APP folder.
  // Otherwise move will fail.
  if (fs.exists(servicePath)) {
    fs.removeDirectory(servicePath);
  }

  ensureFoxxInitialized();

  try {
    _buildServiceInPath(serviceInfo, servicePath, options);
  } catch (e) {
    try {
      fs.removeDirectoryRecursive(servicePath, true);
    } catch (err) {}
    throw e;
  }

  createServiceBundle(mount);

  try {
    const service = FoxxService.create({mount, options, noisy: true});
    service.updateChecksum();
    const serviceDefinition = service.toJSON();
    db._query(aql`
      UPSERT {mount: ${mount}}
      INSERT ${serviceDefinition}
      REPLACE ${serviceDefinition}
      IN ${utils.getStorage()}
    `);
    GLOBAL_SERVICE_MAP.get(db._name()).set(mount, service);
    if (options.setup !== false) {
      service.executeScript('setup');
    }
    ensureServiceExecuted(service, true);
    return service;
  } catch (e) {
    try {
      fs.removeDirectoryRecursive(servicePath, true);
    } catch (e) {
      warn(e);
    }
    const collection = utils.getStorage();
    db._query(aql`
      FOR service IN ${collection}
      FILTER service.mount == ${mount}
      REMOVE service IN ${collection}
    `);
    throw e;
  }
}

function _uninstall (mount, options = {}) { // WTF?
  let service;
  try {
    service = getServiceInstance(mount);
  } catch (e) {
    if (!options.force) {
      throw e;
    }
    warn(e);
  }
  const collection = utils.getStorage();
  db._query(aql`
    FOR service IN ${collection}
    FILTER service.mount == ${mount}
    REMOVE service IN ${collection}
  `);
  GLOBAL_SERVICE_MAP.get(db._name()).delete(mount);
  if (service && options.teardown !== false) {
    try {
      service.executeScript('teardown');
    } catch (e) {
      if (!options.force) {
        throw e;
      }
      warn(e);
    }
  }
  try {
    const servicePath = FoxxService.basePath(mount);
    fs.removeDirectoryRecursive(servicePath, true);
  } catch (e) {
    if (!options.force) {
      throw e;
    }
    warn(e);
  }
  return service;
}

// Service bundle manipulation

function createServiceBundle (mount) {
  const servicePath = FoxxService.basePath(mount);
  const bundlePath = FoxxService.bundlePath(mount);
  if (fs.exists(bundlePath)) {
    fs.remove(bundlePath);
  }
  fs.makeDirectoryRecursive(path.dirname(bundlePath));
  utils.zipDirectory(servicePath, bundlePath);
}

function downloadServiceBundleFromRemote (url) {
  try {
    const res = request.get(url, {encoding: null});
    res.throw();
    const tempFile = fs.getTempFile('downloads', false);
    fs.writeFileSync(tempFile, res.body);
    return tempFile;
  } catch (e) {
    throw Object.assign(
      new ArangoError({
        errorNum: errors.ERROR_SERVICE_SOURCE_ERROR.code,
        errorMessage: dd`
          ${errors.ERROR_SERVICE_SOURCE_ERROR.message}
          URL: ${url}
        `
      }),
      {cause: e}
    );
  }
}

function downloadServiceBundleFromCoordinator (coordId, mount, checksum) {
  const response = parallelClusterRequests([[
    coordId,
    'GET',
    `/_api/foxx/bundle${querystringify({mount})}`,
    null,
    {'if-match': `"${checksum}"`}
  ]])[0];
  // FIXME handle 404 with empty return
  const filename = fs.getTempFile('foxx-manager', true);
  fs.writeFileSync(filename, response.rawBody);
  return filename;
}

function extractServiceBundle (archive, targetPath, isTemporaryFile) { // WTF?
  try {
    const tempFolder = fs.getTempFile('zip', false);
    fs.makeDirectory(tempFolder);
    fs.unzipFile(archive, tempFolder, false, true);

    let found;
    for (const filename of fs.listTree(tempFolder).sort((a, b) => a.length - b.length)) {
      if (filename === 'manifest.json' || filename.endsWith('/manifest.json')) {
        found = filename;
        break;
      }
    }

    if (!found) {
      throw new ArangoError({
        errorNum: errors.ERROR_SERVICE_MANIFEST_NOT_FOUND.code,
        errorMessage: dd`
          ${errors.ERROR_SERVICE_MANIFEST_NOT_FOUND.message}
          Source: ${tempFolder}
        `
      });
    }

    var basePath = path.dirname(path.resolve(tempFolder, found));
    fs.move(basePath, targetPath);

    if (found !== 'manifest.json') { // WTF?
      try {
        fs.removeDirectoryRecursive(tempFolder);
      } catch (e) {
        warn(Object.assign(
          new Error(`Cannot remove temporary folder "${tempFolder}"`),
          {cause: e}
        ));
      }
    }
  } finally {
    if (isTemporaryFile) {
      try {
        fs.remove(archive);
      } catch (e) {
        warn(Object.assign(
          new Error(`Cannot remove temporary file "${archive}"`),
          {cause: e}
        ));
      }
    }
  }
}

function replaceLocalServiceFromTempBundle (mount, tempFile) {
  const bundlePath = FoxxService.bundlePath(mount);
  fs.move(tempFile, bundlePath);
  const servicePath = FoxxService.basePath(mount);
  fs.makeDirectoryRecursive(path.dirname(servicePath));
  extractServiceBundle(bundlePath, servicePath);
}

// Exported functions for manipulating services

function install (serviceInfo, mount, options = {}) {
  utils.validateMount(mount);
  ensureFoxxInitialized();
  const service = _install(serviceInfo, mount, options);
  propagateServiceReplaced(service);
  return service;
}

function uninstall (mount, options = {}) {
  ensureFoxxInitialized();
  const service = _uninstall(mount, options);
  propagateServiceDestroyed(service);
  return service;
}

function replace (serviceInfo, mount, options = {}) { // TODO
  utils.validateMount(mount);
  ensureFoxxInitialized();
  // TODO download & validate (manifest) $serviceInfo before uninstalling old service!
  _uninstall(mount, Object.assign({teardown: true}, options, {force: true}));
  const service = _install(serviceInfo, mount, Object.assign({}, options, {force: true}));
  propagateServiceReplaced(service);
  return service;
}

function upgrade (serviceInfo, mount, options = {}) { // TODO
  ensureFoxxInitialized();
  // TODO download & validate (manifest) $serviceInfo before uninstalling old service!
  const oldService = getServiceInstance(mount);
  const serviceOptions = oldService.toJSON().options;
  Object.assign(serviceOptions.configuration, options.configuration);
  Object.assign(serviceOptions.dependencies, options.dependencies);
  serviceOptions.development = options.development;
  _uninstall(mount, Object.assign({teardown: false}, options, {force: true}));
  const service = _install(serviceInfo, mount, Object.assign({}, options, serviceOptions, {force: true}));
  propagateServiceReplaced(service);
  return service;
}

function runScript (scriptName, mount, options) {
  let service = getServiceInstance(mount);
  if (service.isDevelopment) {
    const runSetup = scriptName !== 'setup';
    service = reloadInstalledService(mount, runSetup);
  }
  ensureServiceLoaded(mount);
  const result = service.executeScript(scriptName, options);
  return result === undefined ? null : result;
}

function runTests (mount, options = {}) {
  let service = getServiceInstance(mount);
  if (service.isDevelopment) {
    service = reloadInstalledService(mount, true);
  }
  ensureServiceLoaded(mount);
  return require('@arangodb/foxx/mocha').run(service, options.reporter);
}

function setDevelopmentMode (mount, enabled = true) {
  const service = getServiceInstance(mount);
  service.development(enabled);
  utils.updateService(mount, service.toJSON());
  if (!enabled) {
    // Make sure setup changes from devmode are respected
    service.executeScript('setup');
  }
  propagateServiceReconfigured(service);
  return service;
}

function setConfiguration (mount, options = {}) {
  const service = getServiceInstance(mount);
  const warnings = service.applyConfiguration(options.configuration, options.replace);
  utils.updateService(mount, service.toJSON());
  propagateServiceReconfigured(service);
  return warnings;
}

function setDependencies (mount, options = {}) {
  const service = getServiceInstance(mount);
  const warnings = service.applyDependencies(options.dependencies, options.replace);
  utils.updateService(mount, service.toJSON());
  propagateServiceReconfigured(service);
  return warnings;
}

// Misc exported functions

function requireService (mount) { // okay-ish
  mount = '/' + mount.replace(/(^\/+|\/+$)/, '');
  const service = getServiceInstance(mount);
  return ensureServiceExecuted(service, true).exports;
}

function getMountPoints () { // WTF?
  ensureFoxxInitialized();
  return Array.from(GLOBAL_SERVICE_MAP.get(db._name()).keys());
}

function installedServices () { // WTF?
  ensureFoxxInitialized();
  return Array.from(GLOBAL_SERVICE_MAP.get(db._name()).values());
}

function listJson () {
  ensureFoxxInitialized();
  const json = [];
  for (const service of GLOBAL_SERVICE_MAP.get(db._name()).values()) {
    json.push({
      mount: service.mount,
      name: service.manifest.name,
      description: service.manifest.description,
      author: service.manifest.author,
      system: service.isSystem,
      development: service.isDevelopment,
      contributors: service.manifest.contributors || false,
      license: service.manifest.license,
      version: service.manifest.version,
      path: service.basePath,
      config: service.getConfiguration(),
      deps: service.getDependencies(),
      scripts: service.getScripts()
    });
  }
  return json;
}

// Exports

exports.install = install;
exports.uninstall = uninstall;
exports.replace = replace;
exports.upgrade = upgrade;
exports.runTests = runTests;
exports.runScript = runScript;
exports.development = (mount) => setDevelopmentMode(mount, true);
exports.production = (mount) => setDevelopmentMode(mount, false);
exports.setConfiguration = setConfiguration;
exports.setDependencies = setDependencies;
exports.requireService = requireService;
exports.lookupService = getServiceInstance;
exports.installedServices = installedServices;

// -------------------------------------------------
// Exported internals
// -------------------------------------------------

exports.reloadInstalledService = reloadInstalledService;
exports.ensureRouted = ensureServiceLoaded;
exports.initializeFoxx = initLocalServiceMap;
exports.ensureFoxxInitialized = ensureFoxxInitialized;
exports._startup = startup;
exports._selfHeal = selfHeal;
exports._resetCache = () => GLOBAL_SERVICE_MAP.clear();
exports._mountPoints = getMountPoints;
exports.listJson = listJson;

// -------------------------------------------------
// Exports from foxx utils module
// -------------------------------------------------

exports.getServiceDefinition = utils.getServiceDefinition;
exports.list = utils.list;
exports.listDevelopment = utils.listDevelopment;
exports.listDevelopmentJson = utils.listDevelopmentJson;

// -------------------------------------------------
// Exports from foxx store module
// -------------------------------------------------

exports.available = store.available;
exports.availableJson = store.availableJson;
exports.getFishbowlStorage = store.getFishbowlStorage;
exports.search = store.search;
exports.searchJson = store.searchJson;
exports.update = store.update;
exports.info = store.info;
