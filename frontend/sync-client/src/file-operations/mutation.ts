export type Mutation = (action: () => Promise<void>) => Promise<void>;
