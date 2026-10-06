// Entry point for the sample-data preview (no sign-in, nothing saved).
import { sampleStore } from './data.js';
import { start } from './app.js';

start(sampleStore, {
  email: 'you@example.com',
  role: 'admin',
  owner: 'you@example.com',
  note: 'Sample data · preview only',
  banner: 'You’re looking at sample data. Changes here aren’t saved.',
});
