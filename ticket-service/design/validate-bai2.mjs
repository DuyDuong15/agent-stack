import {readFileSync} from 'node:fs';
import {buildSchema,assertValidSchema,parse,validate} from 'graphql';
const read=name=>readFileSync(new URL(name,import.meta.url),'utf8');
const schema=buildSchema(read('schema.graphql')+'\n'+read('schema-bai2.graphql'));
assertValidSchema(schema);
const errors=validate(schema,parse(read('examples.graphql')+'\n'+read('examples-bai2.graphql')));
if(errors.length) throw new Error(errors.map(e=>e.message).join('\n'));
console.log('PASS: Bai 1 + Bai 2 SDL and all 6 sample operations. Runtime is tested separately.');
