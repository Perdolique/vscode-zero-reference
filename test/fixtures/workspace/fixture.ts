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
