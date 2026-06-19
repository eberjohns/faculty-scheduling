import xlsx from 'xlsx';
const { readFile, utils } = xlsx;
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const file_path = path.join(__dirname, "../timetable_26_27 Odd.xlsx");
const wb = readFile(file_path);
const sheet = wb.Sheets[wb.SheetNames[0]];
const data = utils.sheet_to_json(sheet, { header: 1 });

for (let i = 0; i < 5; i++) {
  console.log(`Row ${i}:`, data[i].slice(0, 15));
}
