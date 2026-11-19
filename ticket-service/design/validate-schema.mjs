import {readFileSync} from 'node:fs';
import {buildSchema,assertValidSchema,parse,validate} from 'graphql';
const read=name=>readFileSync(new URL(name,import.meta.url),'utf8');
const schema=buildSchema(read('schema.graphql'));
assertValidSchema(schema);
const document=parse(read('examples.graphql'));
const errors=validate(schema,document);
if(errors.length) throw new Error(errors.map(e=>e.message).join('\n'));
console.log(`Valid SDL and ${document.definitions.length} example operations. Runtime resolvers/scalars not tested.`);
