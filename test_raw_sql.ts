import { sql } from './src/db/client.js';

async function testTemplateLiteral() {
  const orderId = '00000000-0000-0000-0000-000000000000';
  
  try {
    await sql`update "orders" set "customer_name" = 'Updated' where "id" = ${orderId}`;
    console.log('Template literal update worked');
  } catch (err) {
    console.error('Template literal update error:', err);
  }
  
  try {
    await sql`update "orders" set "deleted_at" = NULL where "id" = ${orderId}`;
    console.log('Template literal NULL update worked');
  } catch (err) {
    console.error('Template literal NULL update error:', err);
  }
  
  await sql.end();
}

testTemplateLiteral().catch(async (err) => {
  console.error('Test failed:', err);
  await sql.end();
  process.exit(1);
});