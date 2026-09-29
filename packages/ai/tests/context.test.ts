import { describe, expect, it } from "vitest";
import {
  buildPoContext,
  formatPoContextForPrompt,
  mapProcurementKpiRows,
  mapSupplyChainOrders,
  validatePoContextInput,
} from "../src/context";

const supplyOrders = `PO_ID,Supplier_ID,Raw_Material_ID,Order_Date,Order_Quantity,Unit_Cost,Delivery_Date_Planned,Delivery_Date_Actual,Total_Cost
PO000001,SUP1,PROD1,2024-03-19,10,42.5,2024-04-02,2024-04-03,425
PO000002,SUP9,PROD9,2024-03-20,,,2024-04-05,,`;
const supplierMaster = `Supplier_ID,Supplier_Name,Country,Region,On_Time_Delivery_Rate,Certification_Level,Preferred_Supplier_Flag
SUP1,Acme Parts,USA,West,0.9,ISO 9001,1`;
const productMaster = `Product_ID,SKU,Product_Name,Category,Subcategory,Unit,Unit_Cost,Standard_Price,Launch_Date,Discontinuation_Date
PROD1,SKU1,Steel Bolt,Raw Materials,A,pcs,40,50,2022-01-01,`;
const kpi = `PO_ID,Supplier,Order_Date,Delivery_Date,Item_Category,Order_Status,Quantity,Unit_Price,Negotiated_Price,Defective_Units,Compliance
PO-00001,Alpha_Inc,2023-10-17,2023-10-25,Office Supplies,Cancelled,1176,20.13,17.81,,Yes`;

describe("PO context corpus", () => {
  it("joins supply-chain lookups into the canonical shape", () => {
    const [record] = mapSupplyChainOrders(supplyOrders, supplierMaster, productMaster);
    expect(record).toMatchObject({
      poId: "PO000001",
      sourceDataset: "supply-chain",
      supplierId: "SUP1",
      supplierName: "Acme Parts",
      materialId: "PROD1",
      productName: "Steel Bolt",
      quantity: 10,
      unitCost: 42.5,
      totalCost: 425,
      supplierOnTimeRate: 0.9,
      preferredSupplier: true,
      provenance: { sourceDataset: "supply-chain", sourceFile: "procurement_orders.csv" },
    });
  });

  it("represents missing values as null without inventing labels", () => {
    const records = mapSupplyChainOrders(supplyOrders, supplierMaster, productMaster);
    expect(records[1]).toMatchObject({
      poId: "PO000002",
      supplierName: null,
      quantity: null,
      unitCost: null,
      totalCost: null,
      actualDeliveryDate: null,
    });
  });

  it("maps KPI rows standalone without supply-chain joins", () => {
    const [record] = mapProcurementKpiRows(kpi);
    expect(record).toMatchObject({
      poId: "PO-00001",
      sourceDataset: "procurement-kpi",
      supplierId: null,
      supplierName: "Alpha_Inc",
      quantity: 1176,
      unitCost: 20.13,
      negotiatedPrice: 17.81,
      plannedDeliveryDate: null,
      actualDeliveryDate: "2023-10-25",
      defectiveUnits: null,
      orderStatus: "Cancelled",
    });
  });

  it("combines both datasets without cross-joining", () => {
    const records = buildPoContext({ supplyOrdersCsv: supplyOrders, supplierMasterCsv: supplierMaster, productMasterCsv: productMaster, kpiCsv: kpi });
    expect(records).toHaveLength(3);
    expect(records.filter((record) => record.sourceDataset === "supply-chain")).toHaveLength(2);
    expect(records.filter((record) => record.sourceDataset === "procurement-kpi")).toHaveLength(1);
  });

  it("rejects malformed input and validates caller-supplied context", () => {
    expect(() => mapSupplyChainOrders("PO_ID,Supplier_ID\nPO1,SUP1", supplierMaster, productMaster)).toThrow(/Missing required header/);
    expect(() => mapProcurementKpiRows("PO_ID,Supplier\nPO-1,Acme")).toThrow(/Missing required header/);
    expect(() => mapSupplyChainOrders('"unterminated', supplierMaster, productMaster)).toThrow(/unterminated/);
    const [record] = buildPoContext({ supplyOrdersCsv: supplyOrders, supplierMasterCsv: supplierMaster, productMasterCsv: productMaster, kpiCsv: kpi });
    expect(validatePoContextInput([record])?.length).toBe(1);
    expect(validatePoContextInput([{ bad: true }])).toBeNull();
    expect(formatPoContextForPrompt([record!])).toContain("<po_context>");
  });
});
