import {
  Direction,
  Inject,
  Injector,
  IUniverInstanceService,
  Plugin,
  UniverInstanceType,
  type IRange,
  type Workbook,
} from '@univerjs/core';
import { FormulaDataModel } from '@univerjs/engine-formula';
import { IAutoFillService } from '@univerjs/sheets';
import { AibError } from '../schema/index';

/** Public plugin injection keeps engine-only metadata out of the AIB file format. */
export class AibEngineGuardPlugin extends Plugin {
  static override pluginName = 'AIB_ENGINE_GUARD';
  static override type = UniverInstanceType.UNIVER_SHEET;
  constructor(
    private readonly config: { ready: (model: FormulaDataModel, injector: Injector) => void },
    protected readonly _injector: Injector,
  ) {
    super();
  }
  override onReady() {
    this.config.ready(this._injector.get(FormulaDataModel), this._injector);
    const units = this._injector.get(IUniverInstanceService);
    this.disposeWithMe(
      this._injector.get(IAutoFillService).addHook({
        id: 'aib-fill-cell-types',
        onBeforeSubmit({ unitId, subUnitId, source, target }, direction, mode, values) {
          const sheet = units.getUnit<Workbook>(unitId)?.getSheetBySheetId(subUnitId);
          if (!sheet) return;
          // The series rule generates new numbers and drops the ISO date/datetime tag.
          const repeat = (indices: number[], offset: number) =>
            indices[((offset % indices.length) + indices.length) % indices.length];
          target.rows.forEach((r, i) => {
            const row = repeat(
              source.rows,
              direction === Direction.UP ? i - target.rows.length : i,
            );
            target.cols.forEach((c, j) => {
              const cell = values[r]?.[c];
              if (!cell) return;
              const col = repeat(
                source.cols,
                direction === Direction.LEFT ? j - target.cols.length : j,
              );
              const origin =
                mode === 'ONLY_FORMAT' ? sheet.getCellRaw(r, c) : sheet.getCellRaw(row, col);
              const tag = origin?.custom?.aibType;
              if (tag === 'date' || tag === 'datetime')
                cell.custom = { ...cell.custom, aibType: tag };
            });
          });
        },
      }),
    );
  }
}
Inject(Injector)(AibEngineGuardPlugin, undefined, 1);
export function assertScalarFormulas(model: FormulaDataModel | undefined, unitId: string) {
  for (const rows of Object.values(model?.getArrayFormulaRange()[unitId] ?? {}))
    for (const cols of Object.values(rows))
      for (const r of Object.values(cols as Record<string, IRange>))
        if (r && (r.startRow !== r.endRow || r.startColumn !== r.endColumn))
          throw new AibError('UNSUPPORTED_ARRAY', 'Spilling array formulas are outside AIB v1');
}
