#!/usr/bin/env node
import { Application } from './application.js';

const app = new Application();
app.run().catch(console.error);
