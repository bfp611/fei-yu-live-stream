import test from 'node:test'
import assert from 'node:assert/strict'
import { createPerformanceController } from '../backend/live-performance.mjs'
test('head tilt and gesture coexist, then hand returns without automatic emotion',async()=>{
  let now=0;const calls=[]
  const model={internalModel:{coreModel:{getParameterValueById:()=>0,setParameterValueById:()=>{}}},motion:async(...args)=>calls.push(args)}
  const controller=createPerformanceController({model,catalog:{expressions:{}},clock:()=>now,film:{currentTime:0},metrics:{performances:[]},cfg:{speed:1}})
  assert.deepEqual(controller.snapshot(),{expression:'neutral',motion:'none',gesture:'none'})
  await controller.perform({expression:'keep',motion:'tilt_left',duration:3})
  now=1;await controller.perform({expression:'keep',motion:'point',duration:4})
  assert.equal(controller.snapshot().motion,'tilt_left');assert.equal(controller.snapshot().gesture,'point')
  now=6;controller.update();now=8;controller.update()
  assert.deepEqual(calls.map(x=>x[0]),['point_enter','point_exit'])
  assert.equal(controller.snapshot().gesture,'none')
})
