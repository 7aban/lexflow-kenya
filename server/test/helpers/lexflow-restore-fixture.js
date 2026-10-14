// Synthetic baseline core schema; no application startup or live database reads.
module.exports = `
CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,password TEXT,fullName TEXT,role TEXT);
CREATE TABLE clients(id TEXT PRIMARY KEY,name TEXT);
CREATE TABLE matters(id TEXT PRIMARY KEY,reference TEXT,clientId TEXT,title TEXT);
CREATE TABLE time_entries(id TEXT PRIMARY KEY,matterId TEXT,hours REAL);
CREATE TABLE invoices(id TEXT PRIMARY KEY,matterId TEXT,amount REAL);
CREATE TABLE firm_settings(id TEXT PRIMARY KEY,name TEXT);
`;
