/*
__/\\\________/\\\____/\\\\\\\\\______/\\\\\\\\\\\\\_________/\\\\\\\\\_
__\/\\\_______\/\\\__/\\\///////\\\___\/\\\/////////\\\____/\\\////////__
 __\//\\\______/\\\__\/\\\_____\/\\\___\/\\\_______\/\\\__/\\\/___________
  ___\//\\\____/\\\___\/\\\\\\\\\\\/____\/\\\\\\\\\\\\\/__/\\\_____________
   ____\//\\\__/\\\____\/\\\//////\\\____\/\\\/////////___\/\\\_____________
    _____\//\\\/\\\_____\/\\\____\//\\\___\/\\\____________\//\\\____________
     ______\//\\\\\______\/\\\_____\//\\\__\/\\\_____________\///\\\__________
      _______\//\\\_______\/\\\______\//\\\_\/\\\_______________\////\\\\\\\\\_
       ________\///________\///________\///__\///___________________\/////////__


Non-intrusively binds code and provides access in form of asynchronous remote
procedure calls (RPC).
Author: Dr. Burkhard C. Heisen (https://github.com/bheisen/vrpc)


Licensed under the MIT License <http://opensource.org/licenses/MIT>.
Copyright (c) 2018 - 2020 Dr. Burkhard C. Heisen <burkhard.heisen@xsmail.com>.

Permission is hereby  granted, free of charge, to any  person obtaining a copy
of this software and associated  documentation files (the "Software"), to deal
in the Software  without restriction, including without  limitation the rights
to  use, copy,  modify, merge,  publish, distribute,  sublicense, and/or  sell
copies  of  the Software,  and  to  permit persons  to  whom  the Software  is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE  IS PROVIDED "AS  IS", WITHOUT WARRANTY  OF ANY KIND,  EXPRESS OR
IMPLIED,  INCLUDING BUT  NOT  LIMITED TO  THE  WARRANTIES OF  MERCHANTABILITY,
FITNESS FOR  A PARTICULAR PURPOSE AND  NONINFRINGEMENT. IN NO EVENT  SHALL THE
AUTHORS  OR COPYRIGHT  HOLDERS  BE  LIABLE FOR  ANY  CLAIM,  DAMAGES OR  OTHER
LIABILITY, WHETHER IN AN ACTION OF  CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE  OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

const crypto = require('crypto')
const path = require('path')
const fs = require('fs')
const Ajv = require('ajv')
const caller = require('caller')
const shortid = require('shortid')
const commentParser = require('comment-parser')

class VrpcAdapter {
  /**
   * Automatically requires .js files for auto-registration.
   *
   * @param {string} dirPath Relative path to start the auto-registration from
   * @param {integer} [maxLevel] Maximum search depth (default: unlimited)
   */
  static addPluginPath (
    dirPath,
    maxLevel = Number.MAX_SAFE_INTEGER,
    currentLevel = 0
  ) {
    let absDirPath
    let relDirPath
    if (path.isAbsolute(dirPath)) {
      absDirPath = dirPath
      relDirPath = path.relative(__dirname, dirPath)
    } else {
      absDirPath = path.join(caller(), '../', dirPath)
      relDirPath = path.relative(__dirname, absDirPath)
    }
    fs.readdirSync(absDirPath).forEach(node => {
      const absNodePath = path.join(absDirPath, node)
      const type = fs.lstatSync(absNodePath)
      if (type.isDirectory() && maxLevel > currentLevel) {
        VrpcAdapter.addPluginPath(absNodePath, maxLevel, currentLevel + 1)
      }
      if (type.isFile() && absNodePath.slice(-3) === '.js') {
        require('./' + path.join(relDirPath, node))
      }
    })
  }

  /**
   * Registers existing code and makes it (remotely) callable
   *
   * @param {Object|string} code Existing code to be registered, can be a class
   * or function object or a relative path to a module
   * @param {Object} [options]
   * @param {boolean} [options.onlyPublic=true] If true, only registers functions
   * that do not begin with an underscore
   * @param {boolean} [options.withNew=true] If true, class will be constructed
   * using the `new` operator
   * @param {Object} [options.schema=null] If provided is used to validate ctor
   * parameters (only works if registered code reflects a single class)
   * @param {boolean} options.jsdocPath if provided, parses documentation and
   * provides it as meta information (if the code parameter reflects a path this
   * is automatically taken as default)
   *
   * NOTE: This function currently only supports registration of classes (either
   * when provided as object or when exported on the provided module path)
   */
  static register (code, options = {}) {
    if (typeof code === 'string') {
      const absPath = path.resolve(caller(), '../', code)
      const relPath = path.relative(__dirname, absPath)
      const absJsdocPath = `${absPath}.js`
      const Klass = require(relPath)
      this._registerClass(Klass, absJsdocPath, options)
    } else {
      const { jsdocPath } = options
      if (jsdocPath) {
        const absJsdocPath = path.resolve(caller(), '../', jsdocPath, '.js')
        this._registerClass(code, absJsdocPath, { ...options, jsdoc: true })
      } else {
        this._registerClass(code, null, options)
      }
    }
  }

  static getClasses () {
    return JSON.stringify(VrpcAdapter._getClassesArray())
  }

  static getMemberFunctions (className) {
    return JSON.stringify(VrpcAdapter._getMemberFunctionsArray(className))
  }

  static getStaticFunctions (className) {
    return JSON.stringify(VrpcAdapter._getStaticFunctionsArray(className))
  }

  static getMetaData (className) {
    return JSON.stringify(VrpcAdapter._getMetaData(className))
  }

  static getInstances (className) {
    return JSON.stringify(VrpcAdapter._getInstancesArray(className))
  }

  static call (jsonString) {
    const json = JSON.parse(jsonString)
    VrpcAdapter._call(json)
    return JSON.stringify(json)
  }

  static onCallback (callback) {
    VrpcAdapter._callback = callback
  }

  // convenience interface if used in parallel - as local factory and from remote

  /**
   * Creates an un-managed, anonymous instance
   *
   * @param {string} className Name of the class to create an instance of
   * @param  {...any} args  Arguments to provide to the constructor
   * @return The real instance (not a proxy!)
   */
  static create (className, ...args) {
    if (typeof className === 'string') {
      return VrpcAdapter._create(className, ...args)
    }
    if (typeof className === 'object') {
      if (className.instance) {
        return VrpcAdapter._createNamed(
          className.className,
          className.instance,
          ...className.args
        )
      }
      return VrpcAdapter._create(className.className, ...className.args)
    }
  }

  /**
   * Creates a managed named instance
   *
   * @param {string} className Name of the class to create an instance of
   * @param {string} instance Name of the instance
   * @param  {...any} args Arguments to provide to the constructor
   * @return The real instance (not a proxy!)
   */
  static createNamed (className, instance, ...args) {
    return VrpcAdapter._createNamed(className, instance, ...args)
  }

  static delete (instance) {
    return VrpcAdapter._delete(instance)
  }

  static getInstance (instance) {
    const entry = VrpcAdapter._instances.get(instance)
    if (entry) return entry.instance
    throw new Error(`Could not find instance: ${instance}`)
  }

  /**
   * Retrieves an array of all available classes (names only)
   *
   * @return Array of class names
   */
  static getAvailableClasses () {
    return VrpcAdapter._getClassesArray()
  }

  /**
   * Provides the names of all currently running instances.
   *
   * @param {string} className Name of class to retrieve the instances for
   * @return Array of instance names
   */
  static getAvailableInstances (className) {
    return VrpcAdapter._getInstancesArray(className)
  }

  /**
   * Provides all available member functions of the specified class.
   *
   * @param {string} className Name of class to provide member functions for
   * @return Array of member function names
   */
  static getAvailableMemberFunctions (className) {
    return VrpcAdapter._getMemberFunctionsArray(className)
  }

  /**
   * Provides all available static functions of a registered class.
   *
   * @param {string} className Name of class to provide static functions for
   * @return Array of static function names
   */
  static getAvailableStaticFunctions (className) {
    return VrpcAdapter._getStaticFunctionsArray(className)
  }

  /**
   * Provides all available meta data of the registered class.
   *
   * @param {string} className Name of class to provide meta data for
   */
  static getAvailableMetaData (className) {
    return VrpcAdapter._getMetaData(className)
  }

  // private:

  static _registerClass (
    Klass,
    absJsdocPath = null,
    {
      onlyPublic = true,
      withNew = true,
      schema = null,
      jsdoc = true
    } = {}
  ) {
    // Get all static static functions
    let staticFunctions = VrpcAdapter._extractStaticFunctions(Klass)
    if (onlyPublic) {
      staticFunctions = staticFunctions.filter(f => !f.startsWith('_'))
    }
    // Inject constructor and destructor
    staticFunctions.push('__create__')
    staticFunctions.push('__delete__')
    staticFunctions.push('__createNamed__')
    staticFunctions.push('__getNamed__')
    let memberFunctions = VrpcAdapter._extractMemberFunctions(Klass)
    if (onlyPublic) {
      memberFunctions = memberFunctions.filter(f => !f.startsWith('_'))
    }
    let meta = null
    if (jsdoc && absJsdocPath) {
      const content = fs.readFileSync(absJsdocPath).toString('utf8')
      meta = this._parseComments(content)
    }
    VrpcAdapter._functionRegistry.set(
      Klass.name,
      { Klass, withNew, staticFunctions, memberFunctions, schema, meta }
    )
  }

  static _parseComments (content) {
    const comments = commentParser(content, { assocFunctions: true })
    const meta = {}
    comments.forEach(({ tags, description, functionName }) => {
      if (functionName) {
        if (tags) {
          let params = tags.filter(({ tag }) => tag === 'param' || tag === 'arg' || tag === 'argument')
          if (params.length > 0) {
            params = params.map(({ name, optional, description, type }) => {
              return { name, optional, description, type }
            })
          } else {
            params = []
          }
          let ret = tags.filter(({ tag }) => tag === 'returns' || tag === 'return')
          if (ret.length === 1) {
            const { source, type } = ret[0]
            const description = source.split(' ').splice(2).join(' ')
            ret = { description, type }
          } else {
            ret = null
          }
          if (functionName === 'constructor') {
            const modified = [
              {
                name: 'instanceName',
                optional: false,
                description: 'Name of the instance to be created',
                type: 'string'
              },
              ...params
            ]
            meta.__createNamed__ = { description, params: modified, ret }
          } else {
            meta[functionName] = { description, params, ret }
          }
        }
      }
    })
    console.log(JSON.stringify(meta, null, 2))
    return meta
  }

  static _call (json) {
    const { context, method, data } = json
    const wrappedArgs = VrpcAdapter._wrapCallbacks(json)
    // VrpcAdapter._log.debug(`Calling function: ${method} with payload: ${data}`)
    switch (method) {
      // Special case: ctor
      case '__create__':
        try {
          const instance = VrpcAdapter._create(context, ...wrappedArgs)
          const instanceId = shortid.generate()
          VrpcAdapter._instances.set(instanceId, { context, instance })
          data.r = instanceId
        } catch (err) {
          data.e = err.message
        }
        break
      // Special case: dtor
      case '__delete__':
        try {
          const instanceId = wrappedArgs[0]
          data.r = VrpcAdapter._delete(instanceId)
        } catch (err) {
          data.e = err.message
        }
        break
        // Special case: named construction
      case '__createNamed__':
        try {
          VrpcAdapter._createNamed(context, ...wrappedArgs)
          data.r = wrappedArgs[0] // First argument is instanceId
        } catch (err) {
          data.e = err.message
        }
        break
      case '__getNamed__': // Special case: retrieval of known instance
        try {
          const instanceId = wrappedArgs[0]
          const entry = VrpcAdapter._instances.get(instanceId)
          if (entry) data.r = instanceId
          else data.e = `Instance with id: ${instanceId} does not exist`
        } catch (err) {
          data.e = err.message
        }
        break
      // Regular function call
      default: {
        // Check whether context is a registered class
        const entry = VrpcAdapter._functionRegistry.get(context)
        if (entry !== undefined) { // entry is class -> function is static
          const { Klass } = entry
          // TODO Think about whether to do live checking (like here) or
          // rather sticking to those functions registered before...
          if (VrpcAdapter._isFunction(Klass[method])) {
            try {
              const ret = Klass[method].apply(null, wrappedArgs)
              // check if function returns promise
              if (ret && this._isFunction(ret.then)) {
                this._handlePromise(json, method, ret)
              } else data.r = ret
            } catch (err) {
              data.e = err.message
            }
          } else throw new Error(`Could not find function: ${method}`)
        } else { // is not static
          const entry = VrpcAdapter._instances.get(context)
          if (entry === undefined) {
            throw new Error(`Could not find context: ${context}`)
          }
          const { instance } = entry
          if (VrpcAdapter._isFunction(instance[method])) {
            try {
              const ret = instance[method].apply(instance, wrappedArgs)
              // check if function returns promise
              if (ret && this._isFunction(ret.then)) {
                this._handlePromise(json, method, ret)
              } else data.r = ret
            } catch (err) {
              data.e = err.message
            }
          } else throw new Error(`Could not find function: ${method}`)
        }
      }
    }
  }

  static _create (className, ...args) {
    const { Klass, withNew, schema } = VrpcAdapter._getClassEntry(className)
    if (schema !== null) {
      VrpcAdapter._validate(schema, ...args)
    }
    if (withNew) return new Klass(...args)
    return Klass(...args)
  }

  static _createNamed (className, instanceId, ...args) {
    const entry = VrpcAdapter._instances.get(instanceId)
    if (!entry) {
      const instance = VrpcAdapter._create(className, ...args)
      VrpcAdapter._instances.set(instanceId, { className, instance })
      return instance
    }
    return entry.instance
  }

  static _delete (instanceId) {
    const entry = VrpcAdapter._instances.get(instanceId)
    if (entry) {
      VrpcAdapter._instances.delete(instanceId)
      return true
    }
    return false
  }

  static _unregisterEventListeners (clientId) {
    const listeners = VrpcAdapter._listeners[clientId]
    if (listeners) {
      listeners.forEach(({ i, e, f }) => {
        VrpcAdapter.getInstance(i).removeListener(e, f)
      })
    }
  }

  static _validate (schema, params) {
    if (!VrpcAdapter._ajv) {
      VrpcAdapter._ajv = new Ajv({ useDefaults: true })
    }
    const valid = VrpcAdapter._ajv.validate(schema, params)
    if (!valid) throw new Error(VrpcAdapter._ajv.errorsText())
  }

  static _wrapCallbacks (json) {
    const args = VrpcAdapter._extractDataToArray(json.data)
    const wrappedArgs = []
    args.forEach(arg => {
      // Find those args that actually need to be function callbacks
      if (typeof arg === 'string' && arg.substr(0, 5) === '__f__') {
        const f = (...innerArgs) => {
          const data = {}
          innerArgs.forEach((value, index) => {
            data[`_${index + 1}`] = value
          })
          const callbackJson = Object.assign({}, json, { data, id: arg })
          const callbackJsonString = VrpcAdapter._stringifySafely(callbackJson)
          VrpcAdapter._callback(callbackJsonString, callbackJson)
        }
        // Check whether injected callback is an EventEmitter registration
        if (json.method === 'on' && typeof args[0] === 'string') {
          const e = args[0]
          const i = json.context
          const r = arg
          VrpcAdapter._listeners[json.sender]
            ? VrpcAdapter._listeners[json.sender].push({ i, e, f, r })
            : VrpcAdapter._listeners[json.sender] = [{ i, e, f, r }]
        }
        if ((json.method === 'off' || json.method === 'removeListener') &&
          typeof args[0] === 'string') {
          const r = arg
          const entry = VrpcAdapter._listeners[json.sender].find(x => x.r === r)
          if (entry) {
            const { i, e, f } = entry
            VrpcAdapter.getInstance(i).removeListener(e, f)
          }
        }
        wrappedArgs.push(f)
      // Leave the others untouched
      } else {
        wrappedArgs.push(arg)
      }
    })
    return wrappedArgs
  }

  static _handlePromise (json, method, promise) {
    try {
      const cid = VrpcAdapter._correlationId++ % Number.MAX_SAFE_INTEGER
      const id = `__p__${method}-${cid}`
      json.data.r = id
      promise
        .then(value => {
          const data = { r: value }
          const promiseJson = Object.assign({}, json, { data, id })
          const promiseJsonString = VrpcAdapter._stringifySafely(promiseJson)
          VrpcAdapter._callback(promiseJsonString, promiseJson)
        })
        .catch(err => {
          const data = { e: err.message }
          const promiseJson = Object.assign({}, json, { data, id })
          const promiseJsonString = VrpcAdapter._stringifySafely(promiseJson)
          VrpcAdapter._callback(promiseJsonString, promiseJson)
        })
    } catch (err) {
      json.data.e = err.message
    }
  }

  static _stringifySafely (json) {
    let jsonString
    try {
      jsonString = JSON.stringify(json)
    } catch (err) {
      this._log.debug(`Failed serialization of return value for: ${json.context}::${json.method}, because: ${err.message}`)
      json.data.r = '__vrpc::not-serializable__'
      jsonString = JSON.stringify(json)
    }
    return jsonString
  }

  static _extractDataToArray (data) {
    return Object.keys(data).sort()
      .filter(value => value[0] === '_')
      .map(key => data[key])
  }

  static _generateId (object) {
    return crypto.createHash('md5').update(JSON.stringify(object)).digest('hex')
  }

  static _getClassEntry (className) {
    const entry = VrpcAdapter._functionRegistry.get(className)
    if (!entry) {
      throw new Error(`"${className}" is not a registered class`)
    }
    return entry
  }

  static _isFunction (v) {
    if (v) {
      const ident = {}.toString.call(v)
      return ident === '[object Function]' || ident === '[object AsyncFunction]'
    }
    return false
  }

  static _isClass (v) {
    return typeof v === 'function' && /^\s*class\s+/.test(v.toString())
  }

  static _extractMemberFunctions (klass) {
    let klass_ = klass
    let fs = []
    do {
      if (klass_.prototype) {
        fs = [...fs, ...Object.getOwnPropertyNames(klass_.prototype)]
      } else {
        fs = [...fs, ...Object.getOwnPropertyNames(klass_)]
      }
      klass_ = Object.getPrototypeOf(klass_)
    } while (klass_ && klass_.name)
    // Filter out all duplicates
    return Array.from(new Set(fs))
  }

  static _extractStaticFunctions (klass) {
    let klass_ = klass
    let fs = []
    do {
      fs = [...fs, ...Object.getOwnPropertyNames(klass_).filter(prop => {
        const desc = Object.getOwnPropertyDescriptor(klass_, prop)
        return !!desc && typeof desc.value === 'function'
      })]
      klass_ = Object.getPrototypeOf(klass_)
    } while (klass_ && klass_.name)
    // Filter out all duplicates
    return Array.from(new Set(fs))
  }

  static _getClassesArray () {
    return Array.from(VrpcAdapter._functionRegistry.keys())
  }

  static _getInstancesArray (className) {
    const instances = []
    VrpcAdapter._instances.forEach((value, key) => {
      if (value.className === className) instances.push(key)
    })
    return instances
  }

  static _getMemberFunctionsArray (className) {
    const entry = VrpcAdapter._functionRegistry.get(className)
    if (entry) return entry.memberFunctions
    return []
  }

  static _getStaticFunctionsArray (className) {
    const entry = VrpcAdapter._functionRegistry.get(className)
    if (entry) return entry.staticFunctions
    return []
  }

  static _getMetaData (className) {
    const entry = VrpcAdapter._functionRegistry.get(className)
    if (entry && entry.meta) return entry.meta
    return {}
  }
}

// Initialize static members
VrpcAdapter._functionRegistry = new Map()
VrpcAdapter._instances = new Map()
VrpcAdapter._correlationId = 0
VrpcAdapter._listeners = {}

module.exports = VrpcAdapter
