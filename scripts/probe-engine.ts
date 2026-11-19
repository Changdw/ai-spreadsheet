import { Univer, LocaleType } from '@univerjs/core';
import { FUniver } from '@univerjs/core/facade';
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula';
import { UniverSheetsPlugin } from '@univerjs/sheets';
import { UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula';
import '@univerjs/sheets/facade';
import '@univerjs/engine-formula/facade';
import '@univerjs/sheets-formula/facade';

const univer = new Univer({ locale: LocaleType.EN_US });
univer.registerPlugin(UniverFormulaEnginePlugin);
univer.registerPlugin(UniverSheetsPlugin);
univer.registerPlugin(UniverSheetsFormulaPlugin);
const api = FUniver.newAPI(univer);
try {
  const book = api.createWorkbook({
    id: 'probe',
    name: 'probe',
    sheetOrder: ['s1'],
    sheets: {
      s1: {
        id: 's1',
        name: 'Sheet1',
        rowCount: 20,
        columnCount: 10,
        cellData: {
          0: { 0: { v: 10 }, 1: { v: 20 }, 2: { f: '=SUM(A1:B1)' } },
        },
      },
    },
  });
  const calculated = api.getFormula().onCalculationResultApplied(5000);
  api.getFormula().executeCalculation();
  await calculated;
  console.log(JSON.stringify(book.save()));
  console.log('calculated', book.getActiveSheet().getRange('C1').getValue());
} finally {
  univer.dispose();
}
