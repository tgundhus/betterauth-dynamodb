export type Item = Record<string, any>;
export interface Key { pk: string; sk: string }
export interface Change { key: Key; before: Item | null; after: Item | null }
export interface Intent { id: string; entry: number }
export interface Entry extends Key { target: Key; before: number; after: number }
export interface Decision extends Key {
  id: string;
  state: "PREPARING" | "COMMITTED" | "ABORTED";
  count: number;
  prepared: number;
  expires: number;
}
