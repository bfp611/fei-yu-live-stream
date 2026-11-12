import test from 'node:test'
import assert from 'node:assert/strict'
import {createAvatarController} from '../backend/avatar/controller.mjs'
test('expression and motion share clock; receipt waits for both; physics excluded',()=>{
 const ids=['Face','Physics','ParamMouthOpenY'],values={Face:0,Physics:0,ParamMouthOpenY:0},receipts=[]
 const core={_model:{parameters:{ids}},getParameterCount:()=>3,getParameterValueById:id=>values[id],getParameterMinimumValue:()=>0,getParameterMaximumValue:()=>1,setParameterValueById:(id,v)=>values[id]=v}
 const c=createAvatarController(core,{physicsOutputs:['Physics'],expressions:{happy:{Parameters:[{Id:'Face',Value:2,Blend:'Overwrite'},{Id:'Physics',Value:1}]}},motions:{wave:{Meta:{Duration:1},Curves:[]}}},(...r)=>receipts.push(r))
 c.select({id:1,expression:'happy',motion:'wave',seconds:3},0);c.update(.5,.7)
 assert.equal(values.Face,1);assert.equal(values.Physics,0);assert.equal(values.ParamMouthOpenY,.7)
 c.update(1.5);assert.deepEqual(receipts,[]);c.update(3.1);assert.deepEqual(receipts,[[1,'completed']]);assert.equal(values.Face,0)
})
