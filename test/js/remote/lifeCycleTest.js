'use strict'

/* global describe, before, after, it */

const { assert } = require('chai')
const process = require('process')
const EventEmitter = require('events')
const { VrpcAdapter, VrpcAgent, VrpcRemote } = require('../../../index')

class Foo extends EventEmitter {
  constructor (foo) {
    super()
    this._foo = foo
  }

  foo () {
    return this._foo
  }

  echo (value) {
    this.emit('echo', value)
    return value
  }
}

class Bar {
  constructor (bar) {
    this._bar = bar
  }

  bar () {
    return this._bar
  }
}

VrpcAdapter.register(Foo)
VrpcAdapter.register(Bar)

describe('Agent Life-Cycle', () => {
  let agent
  let remote

  describe('Agent up', () => {
    before(async () => {
      agent = new VrpcAgent({
        domain: 'test.vrpc',
        agent: 'nodeJsTestAgent',
        token: process.env.VRPC_TEST_TOKEN,
        broker: 'mqtts://vrpc.io:8883'
      })
      await agent.serve()
      remote = new VrpcRemote({
        domain: 'test.vrpc',
        agent: 'nodeJsTestAgent',
        token: process.env.VRPC_TEST_TOKEN,
        broker: 'mqtts://vrpc.io:8883'
      })
    })
    it('VrpcRemote should see the agent online', (done) => {
      remote.on('agent', ({ domain, agent, status }) => {
        if (domain === 'test.vrpc' &&
        agent === 'nodeJsTestAgent' &&
        status === 'online') {
          remote.removeAllListeners('agent')
          done()
        }
      })
    })
  })

  describe('Agent down (and unregister)', () => {
    it('VrpcRemote should see the agent offline', async () => {
      const promise = new Promise(resolve => {
        remote.on('agent', ({ domain, agent, status }) => {
          if (domain === 'test.vrpc' &&
          agent === 'nodeJsTestAgent' &&
          status === 'offline') {
            remote.removeAllListeners('agent')
            resolve()
          }
        })
      })
      await agent.end({ unregister: true })
      await remote.end()
      await promise
    })
    it('VrpcRemote should not see the agent online', async () => {
      remote = new VrpcRemote({
        domain: 'test.vrpc',
        agent: 'nodeJsTestAgent',
        token: process.env.VRPC_TEST_TOKEN,
        broker: 'mqtts://vrpc.io:8883'
      })
      const promise = new Promise((resolve, reject) => {
        remote.on('agent', ({ domain, agent, status }) => {
          if (domain === 'test.vrpc' &&
          agent === 'nodeJsTestAgent' &&
          status === 'offline') {
            reject(new Error('Agent should have been unregistered'))
          }
        })
        setTimeout(() => {
          remote.removeAllListeners('agent')
          resolve()
        }, 500)
      })
      await remote.connected()
      await promise
      await remote.end()
    })
  })
})

describe('Instance life-cycle', () => {
  let agent
  before(async () => {
    agent = new VrpcAgent({
      domain: 'test.vrpc',
      agent: 'nodeJsTestAgent',
      token: process.env.VRPC_TEST_TOKEN,
      broker: 'mqtts://vrpc.io:8883'
    })
    await agent.serve()
  })
  after(async () => {
    await agent.end()
  })
  describe('Instances up', () => {
    let remote
    before(async () => {
      remote = new VrpcRemote({
        domain: 'test.vrpc',
        agent: 'nodeJsTestAgent',
        token: process.env.VRPC_TEST_TOKEN,
        broker: 'mqtts://vrpc.io:8883'
      })
      await remote.connected()
    })
    after(async () => {
      await remote.end()
    })
    it('should be possible to start several instances', async () => {
      await remote.create({
        className: 'Foo',
        instance: 'foo-1',
        args: ['foo-1']
      })
      await remote.create({
        className: 'Foo',
        instance: 'foo-2',
        args: ['foo-2']
      })
      await remote.create({
        className: 'Bar',
        instance: 'bar-1',
        args: ['bar-1']
      })
      const foo3 = await remote.create({
        className: 'Foo',
        args: ['foo-3']
      })
      assert.strictEqual(await foo3.foo(), 'foo-3')
    })
  })
  describe('Instances attach', () => {
    const inst1 = {}
    let remote
    before(async () => {
      remote = new VrpcRemote({
        domain: 'test.vrpc',
        agent: 'nodeJsTestAgent',
        token: process.env.VRPC_TEST_TOKEN,
        broker: 'mqtts://vrpc.io:8883'
      })
      remote.on('class', ({ domain, agent, className, instances }) => {
        inst1[className] = instances
      })
      await remote.connected()
    })
    after(async () => {
      await remote.end()
    })
    it('should be possible to list and attach all instances', async () => {
      assert.deepEqual(inst1, { Foo: ['foo-1', 'foo-2'], Bar: ['bar-1'] })
      const inst2 = await remote.getAvailableInstances('Foo')
      assert.deepEqual(inst2, ['foo-1', 'foo-2'])
      const foo1 = await remote.getInstance({
        className: 'Foo',
        instance: 'foo-1'
      })
      assert.strictEqual(await foo1.foo(), 'foo-1')
      const foo2 = await remote.getInstance({
        className: 'Foo',
        instance: 'foo-2'
      })
      assert.strictEqual(await foo2.foo(), 'foo-2')
      const bar1 = await remote.getInstance({
        className: 'Bar',
        instance: 'bar-1'
      })
      assert.strictEqual(await bar1.bar(), 'bar-1')
    })
    it('should be possible to delete instances', async () => {
      await remote.delete({ className: 'Foo', instance: 'foo-2' })
      const inst2 = await remote.getAvailableInstances('Foo')
      assert.deepEqual(inst1, { Foo: ['foo-1'], Bar: ['bar-1'] })
      assert.deepEqual(inst2, ['foo-1'])
    })
  })
})

describe('Event Callbacks', () => {
  let agent
  let remote
  const events = []
  const otherEvents = []
  before(async () => {
    agent = new VrpcAgent({
      domain: 'test.vrpc',
      agent: 'nodeJsTestAgent',
      token: process.env.VRPC_TEST_TOKEN,
      broker: 'mqtts://vrpc.io:8883'
    })
    await agent.serve()
    remote = new VrpcRemote({
      domain: 'test.vrpc',
      agent: 'nodeJsTestAgent',
      token: process.env.VRPC_TEST_TOKEN,
      broker: 'mqtts://vrpc.io:8883'
    })
    await remote.connected()
  })
  after(async () => {
    await remote.end()
    await agent.end()
  })
  it('should receive events on fresh instance', async () => {
    const foo = await remote.create({
      className: 'Foo',
      instance: 'foo'
    })
    let ret = await foo.echo(0)
    assert.strictEqual(ret, 0)
    await foo.on('echo', value => events.push(value))
    ret = await foo.echo(1)
    assert.strictEqual(ret, 1)
    ret = await foo.echo(2)
    assert.strictEqual(ret, 2)
    assert.deepEqual(events, [1, 2])
    await foo.removeAllListeners('echo')
  })
  it('should further receive events on another instance', async () => {
    const anotherFoo = await remote.create({
      className: 'Foo',
      instance: 'foo'
    })
    let ret = await anotherFoo.echo(3)
    assert.strictEqual(ret, 3)
    await anotherFoo.on('echo', value => otherEvents.push(value))
    ret = await anotherFoo.echo(4)
    assert.strictEqual(ret, 4)
    ret = await anotherFoo.echo(5)
    assert.strictEqual(ret, 5)
    assert.deepEqual(otherEvents, [4, 5])
  })
  it('should not have received further events on the original instance', () => {
    assert.deepEqual(events, [1, 2])
  })
})