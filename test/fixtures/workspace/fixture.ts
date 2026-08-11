export interface MergedModel {
  id: string;
}

export interface MergedModel {
  label: string;
}

export function overloaded(value: string): string;
export function overloaded(value: number): number;
export function overloaded(value: string | number): string | number {
  return value;
}

export class ComputedMember {
  ["literal"](): void {}
}

new ComputedMember()["literal"]();

export const shorthandValue = 1;

export const shorthandObject = { shorthandValue };

interface ContractEnvironment {
  REGISTRY_ENVIRONMENT: string;
}

interface ContractContext {
  readonly env: ContractEnvironment;
  json(value: unknown, status?: number): unknown;
}

declare class ContractApp<Environment> {
  get(path: string, handler: (context: ContractContext) => unknown): void;
  notFound(handler: (context: ContractContext) => unknown): void;
}

const contractApp = new ContractApp<{ Bindings: ContractEnvironment }>();

contractApp.get('/api/health', context =>
  context.json({
    environment: context.env.REGISTRY_ENVIRONMENT,
    runtime: 'workerd',
    status: 'ok'
  })
);

contractApp.notFound(context =>
  context.json({ error: 'Not found' }, 404)
);

export class PreservedClassMember {
  readonly preservedClassProperty = true;
}

export default contractApp;
