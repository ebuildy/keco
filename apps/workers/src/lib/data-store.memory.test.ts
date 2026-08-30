import { describeDataStore } from './data-store.conformance';
import { InMemoryDataStore } from './data-store.memory';

describeDataStore('InMemoryDataStore', async () => ({ store: new InMemoryDataStore() }));
