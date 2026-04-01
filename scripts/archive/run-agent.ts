import dotenv from 'dotenv';
dotenv.config();

import { runFinancialAgent } from '../../src/services/agent/financialAgent.ts';

runFinancialAgent()
  .then(() => {
    console.log('Final success!');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Final fatal error:', err);
    process.exit(1);
  });
