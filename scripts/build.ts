import { compileFile } from 'cashc';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { asmToScript } from '@cashscript/utils';

mkdirSync('artifacts', { recursive: true });
for (const name of ['RewardPool', 'ReceiptHold']) {
  const source = resolve(`contracts/${name}.cash`);
  const artifact = compileFile(source);
  writeFileSync(`artifacts/${name}.json`, JSON.stringify(artifact, null, 2));
  const script = asmToScript(artifact.bytecode);
  console.log(`compiled ${source}`);
  console.log(`  redeem script: ${script.length} bytes`);
  console.log(`  functions    : ${artifact.abi.map((f) => f.name).join(', ')}`);
  console.log(`  abi          : ${JSON.stringify(artifact.abi.map((f) => f.inputs.map((i) => `${i.type} ${i.name}`)))}`);
}
