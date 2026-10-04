/**
 * The ERP records a cloud file can be linked to — Document Center, Agent 4.
 *
 * One row per kind. The id column is the one the record's paperclip files
 * under (a uuid for most, the code for a project or a partner), the label the
 * number a person knows it by, the route the screen that shows it. Routes
 * never move with the menu (D-FX-1), so the href is safe to keep in a link.
 *
 * The Task Center and the other platform modules add their own kind with
 * `registerCloudLinkTarget` when they land; they do not edit this list.
 */
import { registerCloudLinkTarget, type CloudLinkTarget } from '../services/cloud-link-targets';

const enc = encodeURIComponent;

const uuidRecord = (
  type: string,
  table: string,
  labelColumn: string,
  route: string,
  folderName: string,
  object = type,
  branchColumn: string | null = 'branch_code',
): CloudLinkTarget => ({
  type,
  object,
  folderName,
  table,
  idColumn: 'id',
  idKind: 'uuid',
  labelColumn,
  branchColumn,
  href: (label) => `${route}/${enc(label)}`,
});

export const CLOUD_LINK_TARGETS: readonly CloudLinkTarget[] = [
  // Purchasing and payables
  uuidRecord('ap_invoice', 'ap_invoice', 'invoice_no', '/payables/invoices', 'Purchase Invoices'),
  uuidRecord('purchase_order', 'purchase_order', 'order_no', '/payables/purchase-orders', 'Purchase Orders'),
  uuidRecord('goods_receipt', 'goods_receipt', 'receipt_no', '/payables/goods-receipts', 'Goods Receipts'),
  uuidRecord('goods_return', 'goods_return', 'return_no', '/payables/goods-returns', 'Goods Returns'),
  uuidRecord('supplier_payment', 'supplier_payment', 'payment_no', '/payables/supplier-payments', 'Supplier Payments'),
  uuidRecord('supplier_advance', 'supplier_advance', 'advance_no', '/payables/advances', 'Supplier Advances'),
  uuidRecord('payment_application', 'payment_application', 'application_no', '/payables/payment-applications', 'Payment Applications'),
  // The import application is a payable.
  uuidRecord('payable', 'payable', 'payable_no', '/payables', 'Import Applications'),
  // Logistics and customs
  uuidRecord('bill_of_lading', 'bill_of_lading', 'bl_no', '/payables/shipments', 'Bills of Lading'),
  uuidRecord('shipment_container', 'shipment_container', 'container_no', '/payables/containers', 'Containers'),
  uuidRecord('customs_pd', 'customs_pd', 'pd_no', '/payables/pd', 'Customs PDs'),
  uuidRecord('customs_declaration', 'customs_declaration', 'declaration_no', '/logistics/customs-declarations', 'Customs Declarations'),
  // Receivables
  uuidRecord('ar_invoice', 'ar_invoice', 'invoice_no', '/sales/ar-invoices', 'Sales Invoices'),
  uuidRecord('customer_receipt', 'customer_receipt', 'receipt_no', '/sales/customer-receipts', 'Customer Receipts'),
  uuidRecord('sales_return', 'sales_return', 'return_no', '/sales/sales-returns', 'Sales Returns'),
  // Treasury and the books
  uuidRecord('bank_loan', 'bank_loan', 'loan_no', '/treasury/loans', 'Bank Loans'),
  uuidRecord('journal_entry', 'journal_entry', 'entry_no', '/finance/journals', 'Journal Entries'),
  // People and projects
  uuidRecord('employee', 'employee', 'employee_no', '/hr/employees', 'Employees'),
  {
    type: 'project',
    object: 'project',
    folderName: 'Projects',
    table: 'project',
    idColumn: 'code',
    idKind: 'text',
    labelColumn: 'code',
    branchColumn: 'branch_code',
    href: (label) => `/projects/${enc(label)}`,
  },
  // Customers and suppliers are one master (company-wide), seen by their role.
  {
    type: 'customer',
    object: 'business_partner',
    folderName: 'Customers',
    auditObject: 'business_partner',
    table: 'business_partner',
    idColumn: 'code',
    idKind: 'text',
    labelColumn: 'code',
    branchColumn: null,
    where: '"is_customer" = true',
    href: (label) => `/sales/customers/${enc(label)}?role=customer`,
  },
  {
    type: 'supplier',
    object: 'business_partner',
    folderName: 'Suppliers',
    auditObject: 'business_partner',
    table: 'business_partner',
    idColumn: 'code',
    idKind: 'text',
    labelColumn: 'code',
    branchColumn: null,
    where: '"is_supplier" = true',
    href: (label) => `/payables/suppliers/${enc(label)}?role=supplier`,
  },
];

export function registerCloudLinkTargets(): void {
  for (const target of CLOUD_LINK_TARGETS) registerCloudLinkTarget(target);
}
