// Loads backend/.env relative to this file (not the current directory), so
// command-line tools find the right settings wherever they're run from.
// Import this FIRST — before anything that opens a database connection.
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../../.env') });
