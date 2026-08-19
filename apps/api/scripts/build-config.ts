import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const sourceDirectory = join(import.meta.dir, '..', 'src');
const entityDirectory = join(sourceDirectory, 'entities');
const baseConfig = JSON.parse(await readFile(join(sourceDirectory, 'config.base.json'), 'utf8'));
const entityFiles = (await readdir(entityDirectory))
  .filter((file) => file.endsWith('.json'))
  .sort();
const loadedEntities = await Promise.all(
  entityFiles.map(async (file) => JSON.parse(await readFile(join(entityDirectory, file), 'utf8'))),
);
const entities: typeof loadedEntities = [];
const remainingEntities = new Map(loadedEntities.map((entity) => [entity.table_name, entity]));

while (remainingEntities.size > 0) {
  const nextEntity = [...remainingEntities.values()].find((entity) =>
    (entity.columns ?? []).every((column: { references?: { table: string } }) =>
      !column.references ||
      column.references.table === entity.table_name ||
      !remainingEntities.has(column.references.table),
    ),
  );

  if (!nextEntity) {
    throw new Error('Entity references contain a cycle');
  }

  entities.push(nextEntity);
  remainingEntities.delete(nextEntity.table_name);
}

await writeFile(
  join(sourceDirectory, 'config.json'),
  `${JSON.stringify(
    {
      $schema: '../node_modules/nucleus-core-ts/schemas/config.nucleus.json',
      ...baseConfig,
      entities,
    },
    null,
    2,
  )}\n`,
);
