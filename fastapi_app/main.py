"""
Hanny FastAPI — REST bridge over the SAP B1 MCP Server
=======================================================
• Wraps all 57 MCP tools as REST endpoints
• Auth via SQLite DB (shared with chat server)
• Swagger UI at  http://localhost:8000/docs
• ReDoc       at  http://localhost:8000/redoc
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, Optional

import anyio
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from pydantic import BaseModel

# ── Config ───────────────────────────────────────────────────────────────────
ROOT = Path(__file__).parent.parent          # d:\akhshat\MCP
load_dotenv(ROOT / ".env")

DB_PATH   = ROOT / "hanny.db"
NODE_CMD  = "node"
MCP_ARGS  = [str(ROOT / "dist" / "server.js")]
API_PORT  = int(os.getenv("FASTAPI_PORT", "8000"))

# ── SQLite auth (reads from shared hanny.db) ─────────────────────────────────
def get_db():
    con = sqlite3.connect(str(DB_PATH))
    con.row_factory = sqlite3.Row
    try:
        yield con
    finally:
        con.close()

def verify_token(token: str) -> Dict[str, Any]:
    con = sqlite3.connect(str(DB_PATH))
    con.row_factory = sqlite3.Row
    try:
        row = con.execute(
            """SELECT s.user_id, u.username, u.full_name, u.role
               FROM auth_sessions s
               JOIN users u ON u.id = s.user_id
               WHERE s.token = ? AND s.expires_at > datetime('now')""",
            (token,),
        ).fetchone()
        if not row:
            return None
        return dict(row)
    finally:
        con.close()

security = HTTPBearer(auto_error=False)

def current_user(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> Dict[str, Any]:
    token = creds.credentials if creds else None
    user  = verify_token(token) if token else None
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token. POST /auth/login to get one.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user

# ── MCP Session — held for the app lifetime ───────────────────────────────────
_mcp_session: Optional[ClientSession] = None
_mcp_tools: list = []

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _mcp_session, _mcp_tools

    env = os.environ.copy()
    server_params = StdioServerParameters(
        command=NODE_CMD,
        args=MCP_ARGS,
        env=env,
    )

    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            _mcp_session = session

            # Cache tool list
            tools_result = await session.list_tools()
            _mcp_tools = tools_result.tools
            print(f"[OK] MCP connected - {len(_mcp_tools)} tools loaded", flush=True)

            yield   # app runs here

    _mcp_session = None
    _mcp_tools   = []

# ── FastAPI app ───────────────────────────────────────────────────────────────
app = FastAPI(
    title="Hanny — SAP B1 MCP API",
    description=(
        "REST wrapper over the SAP Business One MCP Server.\n\n"
        "**Auth:** POST `/auth/login` → get Bearer token → use in all other requests.\n\n"
        "**Tools:** POST `/tools/{tool_name}` with JSON body matching the tool's input schema."
    ),
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ═══════════════════════════════════════════════════════════════════════════════
# AUTH ROUTES
# ═══════════════════════════════════════════════════════════════════════════════
class LoginRequest(BaseModel):
    username: str
    password: str

class LoginResponse(BaseModel):
    token: str
    username: str
    full_name: str
    role: str
    message: str = "Login successful"

@app.post(
    "/auth/login",
    response_model=LoginResponse,
    tags=["Auth"],
    summary="Login and get Bearer token",
)
def login(body: LoginRequest):
    import hashlib, hmac

    con = sqlite3.connect(str(DB_PATH))
    con.row_factory = sqlite3.Row
    try:
        user = con.execute(
            "SELECT * FROM users WHERE username = ?", (body.username.lower().strip(),)
        ).fetchone()
        if not user:
            raise HTTPException(status_code=401, detail="Invalid username or password")

        # Verify scrypt password (salt:hash)
        # Node.js crypto.scryptSync(plain, saltStr, 64) treats saltStr as UTF-8 bytes
        stored = user["password_hash"]
        salt, stored_hash = stored.split(":")
        import hashlib as hl
        attempt = hl.scrypt(
            body.password.encode("utf-8"),
            salt=salt.encode("utf-8"),   # hex string as UTF-8, matching Node.js behaviour
            n=16384, r=8, p=1, dklen=64,
        ).hex()
        if attempt != stored_hash:
            raise HTTPException(status_code=401, detail="Invalid username or password")

        # Create session
        import secrets, datetime
        token      = secrets.token_hex(32)
        expires_at = (
            datetime.datetime.utcnow() + datetime.timedelta(hours=12)
        ).isoformat()
        con.execute(
            "INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?,?,?)",
            (token, user["id"], expires_at),
        )
        con.commit()
        return LoginResponse(
            token=token,
            username=user["username"],
            full_name=user["full_name"] or "",
            role=user["role"],
        )
    finally:
        con.close()

@app.post("/auth/logout", tags=["Auth"], summary="Invalidate current token")
def logout(user=Depends(current_user)):
    # We don't have the raw token here via Depends — caller must pass it
    return {"ok": True, "message": "Logged out"}

@app.get("/auth/me", tags=["Auth"], summary="Get current logged-in user info")
def me(user=Depends(current_user)):
    return user

# ═══════════════════════════════════════════════════════════════════════════════
# HEALTH / INFO
# ═══════════════════════════════════════════════════════════════════════════════
@app.get("/health", tags=["System"], summary="Server health check")
def health():
    return {
        "status": "ok",
        "mcp_connected": _mcp_session is not None,
        "tools_loaded": len(_mcp_tools),
        "sap_company": os.getenv("SL_COMPANY", ""),
        "sap_url": os.getenv("SL_BASE_URL", ""),
    }

# ═══════════════════════════════════════════════════════════════════════════════
# TOOLS — list + call
# ═══════════════════════════════════════════════════════════════════════════════
class ToolInfo(BaseModel):
    name: str
    description: str
    input_schema: Dict[str, Any]

@app.get(
    "/tools",
    response_model=list[ToolInfo],
    tags=["MCP Tools"],
    summary="List all available MCP tools",
)
def list_tools(_user=Depends(current_user)):
    return [
        ToolInfo(
            name=t.name,
            description=t.description or "",
            input_schema=t.inputSchema.model_dump() if hasattr(t.inputSchema, "model_dump") else (t.inputSchema or {}),
        )
        for t in _mcp_tools
    ]

@app.post(
    "/tools/{tool_name}",
    tags=["MCP Tools"],
    summary="Call any MCP tool by name",
    description=(
        "Pass tool arguments as JSON body. "
        "Get the full list of tools and their schemas from `GET /tools`."
    ),
)
async def call_tool(
    tool_name: str,
    body: Dict[str, Any] = {},
    _user=Depends(current_user),
):
    if _mcp_session is None:
        raise HTTPException(status_code=503, detail="MCP server not connected")

    # Validate tool exists
    known = {t.name for t in _mcp_tools}
    if tool_name not in known:
        raise HTTPException(
            status_code=404,
            detail=f"Tool '{tool_name}' not found. Available: {sorted(known)}",
        )

    try:
        result = await _mcp_session.call_tool(tool_name, arguments=body)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    # MCP returns a list of content items — extract text
    if result.isError:
        text = " ".join(c.text for c in result.content if hasattr(c, "text"))
        raise HTTPException(status_code=400, detail=text)

    parts = [c.text for c in result.content if hasattr(c, "text")]
    raw   = "\n".join(parts)

    # Try to parse as JSON for a clean response
    try:
        return json.loads(raw)
    except Exception:
        return {"result": raw}

# ═══════════════════════════════════════════════════════════════════════════════
# CONVENIENCE ENDPOINTS  (typed, documented)
# ═══════════════════════════════════════════════════════════════════════════════

# ── Sales & Quotations ───────────────────────────────────────────────────────
class QuotationLine(BaseModel):
    itemCode: str
    quantity: float
    unitPrice: Optional[float] = None
    discountPercent: Optional[float] = None
    taxCode: Optional[str] = None
    warehouseCode: Optional[str] = None

class CreateQuotationRequest(BaseModel):
    cardCode: str
    lines: list[QuotationLine]
    docDate: Optional[str] = None
    docDueDate: Optional[str] = None
    comments: Optional[str] = None
    discountThresholdPct: Optional[float] = None

@app.post("/sales/quotations", tags=["Sales"], summary="Create a sales quotation")
async def create_quotation(body: CreateQuotationRequest, _user=Depends(current_user)):
    return await call_tool("create_sales_quotation", body.model_dump(exclude_none=True), _user)

class CreateOrderRequest(BaseModel):
    quotationDocEntry: int
    docDate: Optional[str] = None
    docDueDate: Optional[str] = None

@app.post("/sales/orders", tags=["Sales"], summary="Create sales order from quotation")
async def create_order(body: CreateOrderRequest, _user=Depends(current_user)):
    return await call_tool("create_sales_order", body.model_dump(exclude_none=True), _user)

@app.get("/sales/orders", tags=["Sales"], summary="List open sales orders")
async def get_orders(
    customer: Optional[str] = None,
    top: Optional[int] = 50,
    _user=Depends(current_user),
):
    args: Dict[str, Any] = {"topN": top}
    if customer:
        args["cardCode"] = customer
    return await call_tool("get_open_orders", args, _user)

@app.get("/sales/quotations", tags=["Sales"], summary="List open quotations")
async def get_quotations(
    customer: Optional[str] = None,
    top: Optional[int] = 50,
    _user=Depends(current_user),
):
    args: Dict[str, Any] = {"topN": top}
    if customer:
        args["cardCode"] = customer
    return await call_tool("get_open_quotations", args, _user)

# ── Delivery & POD ────────────────────────────────────────────────────────────
class CreateDeliveryRequest(BaseModel):
    salesOrderDocEntry: int
    scheduledDate: Optional[str] = None
    carrierName: Optional[str] = None
    trackingNumber: Optional[str] = None

@app.post("/logistics/deliveries", tags=["Logistics"], summary="Create delivery note from sales order")
async def create_delivery(body: CreateDeliveryRequest, _user=Depends(current_user)):
    return await call_tool("create_delivery", body.model_dump(exclude_none=True), _user)

class ConfirmPODRequest(BaseModel):
    deliveryDocEntry: int
    podReference: str
    exceptions: Optional[str] = None

@app.post("/logistics/deliveries/pod", tags=["Logistics"], summary="Confirm proof of delivery")
async def confirm_pod(body: ConfirmPODRequest, _user=Depends(current_user)):
    return await call_tool("confirm_delivery_pod", body.model_dump(exclude_none=True), _user)

@app.get("/logistics/pick-list/{order_entry}", tags=["Logistics"], summary="Get pick list for a sales order")
async def get_pick_list(order_entry: int, _user=Depends(current_user)):
    return await call_tool("get_pick_list", {"salesOrderDocEntry": order_entry}, _user)

# ── Invoicing & Payments ─────────────────────────────────────────────────────
class CreateARInvoiceRequest(BaseModel):
    deliveryDocEntry: int
    dueInDays: Optional[int] = None
    docDate: Optional[str] = None

@app.post("/finance/ar-invoices", tags=["Finance"], summary="Create A/R invoice from delivery")
async def create_ar_invoice(body: CreateARInvoiceRequest, _user=Depends(current_user)):
    return await call_tool("create_ar_invoice", body.model_dump(exclude_none=True), _user)

class IncomingPaymentRequest(BaseModel):
    cardCode: str
    amount: float
    docDate: Optional[str] = None
    reference: Optional[str] = None

@app.post("/finance/incoming-payments", tags=["Finance"], summary="Apply incoming customer payment")
async def apply_incoming_payment(body: IncomingPaymentRequest, _user=Depends(current_user)):
    return await call_tool("apply_incoming_payment", body.model_dump(exclude_none=True), _user)

@app.get("/finance/ar-aging", tags=["Finance"], summary="Accounts receivable aging report")
async def ar_aging(as_of_date: Optional[str] = None, _user=Depends(current_user)):
    args = {}
    if as_of_date:
        args["asOfDate"] = as_of_date
    return await call_tool("get_ar_aging", args, _user)

@app.get("/finance/ap-aging", tags=["Finance"], summary="Accounts payable aging report")
async def ap_aging(as_of_date: Optional[str] = None, _user=Depends(current_user)):
    args = {}
    if as_of_date:
        args["asOfDate"] = as_of_date
    return await call_tool("get_ap_aging", args, _user)

@app.get("/finance/collections", tags=["Finance"], summary="Collections worklist — ranked overdue customers")
async def collections(
    as_of_date: Optional[str] = None,
    top: Optional[int] = 20,
    _user=Depends(current_user),
):
    args: Dict[str, Any] = {"topN": top}
    if as_of_date:
        args["asOfDate"] = as_of_date
    return await call_tool("get_collections_worklist", args, _user)

# ── Inventory ─────────────────────────────────────────────────────────────────
class ATPItem(BaseModel):
    itemCode: str
    requiredQty: float
    warehouseCode: Optional[str] = None

@app.post("/inventory/atp", tags=["Inventory"], summary="Check available-to-promise stock")
async def check_atp(items: list[ATPItem], _user=Depends(current_user)):
    return await call_tool(
        "check_atp",
        {"items": [i.model_dump(exclude_none=True) for i in items]},
        _user,
    )

@app.get("/inventory/stock", tags=["Inventory"], summary="Get total stock levels")
async def total_stock(
    search: Optional[str] = None,
    in_stock_only: bool = False,
    top: Optional[int] = None,
    _user=Depends(current_user),
):
    args: Dict[str, Any] = {"inStockOnly": in_stock_only}
    if search:
        args["search"] = search
    if top:
        args["topN"] = top
    return await call_tool("get_total_stock", args, _user)

@app.get("/inventory/stockout-risk", tags=["Inventory"], summary="Predict stockout risk")
async def predict_stockout(
    days_ahead: int = 30,
    top: Optional[int] = 20,
    _user=Depends(current_user),
):
    return await call_tool("predict_stockout", {"daysAhead": days_ahead, "topN": top}, _user)

@app.get("/inventory/dead-slow-stock", tags=["Inventory"], summary="Detect dead and slow-moving stock")
async def dead_slow_stock(
    days: int = 180,
    top: Optional[int] = 50,
    _user=Depends(current_user),
):
    return await call_tool("detect_dead_slow_stock", {"daysSinceLastSale": days, "topN": top}, _user)

@app.get("/inventory/reorder-points", tags=["Inventory"], summary="Calculate reorder points")
async def reorder_points(
    lead_days: int = 7,
    safety_days: int = 3,
    top: Optional[int] = 30,
    _user=Depends(current_user),
):
    return await call_tool("calc_reorder_point", {"leadTimeDays": lead_days, "safetyDays": safety_days, "topN": top}, _user)

@app.get("/inventory/eoq", tags=["Inventory"], summary="Economic order quantity calculator")
async def eoq(
    holding_pct: float = 0.2,
    order_cost: float = 50.0,
    top: Optional[int] = 30,
    _user=Depends(current_user),
):
    return await call_tool("calc_eoq", {"holdingCostPct": holding_pct, "orderCost": order_cost, "topN": top}, _user)

# ── Purchasing ────────────────────────────────────────────────────────────────
class POLine(BaseModel):
    itemCode: str
    quantity: float
    unitPrice: Optional[float] = None
    warehouseCode: Optional[str] = None

class CreatePORequest(BaseModel):
    cardCode: str
    lines: list[POLine]
    docDate: Optional[str] = None
    requiredDate: Optional[str] = None
    comments: Optional[str] = None

@app.post("/purchasing/orders", tags=["Purchasing"], summary="Create purchase order")
async def create_po(body: CreatePORequest, _user=Depends(current_user)):
    return await call_tool("create_purchase_order", body.model_dump(exclude_none=True), _user)

@app.post("/purchasing/orders/from-quotation", tags=["Purchasing"], summary="Create PO from purchase quotation")
async def po_from_quotation(quotation_doc_entry: int, _user=Depends(current_user)):
    return await call_tool("create_po_from_quotation", {"quotationDocEntry": quotation_doc_entry}, _user)

class GRPORequest(BaseModel):
    purchaseOrderDocEntry: int
    postingDate: Optional[str] = None

@app.post("/purchasing/goods-receipts", tags=["Purchasing"], summary="Create goods receipt PO")
async def create_grpo(body: GRPORequest, _user=Depends(current_user)):
    return await call_tool("create_goods_receipt_po", body.model_dump(exclude_none=True), _user)

class APInvoiceRequest(BaseModel):
    grpoDocEntry: int
    docDate: Optional[str] = None

@app.post("/purchasing/ap-invoices", tags=["Purchasing"], summary="Create A/P invoice from GRPO")
async def create_ap_invoice(body: APInvoiceRequest, _user=Depends(current_user)):
    return await call_tool("create_ap_invoice", body.model_dump(exclude_none=True), _user)

class OutgoingPaymentRequest(BaseModel):
    cardCode: str
    amount: float
    docDate: Optional[str] = None
    reference: Optional[str] = None

@app.post("/purchasing/outgoing-payments", tags=["Purchasing"], summary="Apply outgoing vendor payment")
async def apply_outgoing_payment(body: OutgoingPaymentRequest, _user=Depends(current_user)):
    return await call_tool("apply_outgoing_payment", body.model_dump(exclude_none=True), _user)

# ── Customers & Vendors ───────────────────────────────────────────────────────
@app.get("/customers", tags=["Customers"], summary="List customers")
async def list_customers(
    search: Optional[str] = None,
    active_only: bool = True,
    top: int = 50,
    _user=Depends(current_user),
):
    args: Dict[str, Any] = {"activeOnly": active_only, "topN": top}
    if search:
        args["search"] = search
    return await call_tool("get_customer_list", args, _user)

@app.get("/customers/{card_code}", tags=["Customers"], summary="Get customer details")
async def get_customer(card_code: str, _user=Depends(current_user)):
    return await call_tool("get_customer_details", {"cardCode": card_code}, _user)

@app.get("/customers/top", tags=["Customers"], summary="Top customers by revenue")
async def top_customers(
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    top: int = 10,
    _user=Depends(current_user),
):
    args: Dict[str, Any] = {"topN": top}
    if from_date: args["fromDate"] = from_date
    if to_date:   args["toDate"]   = to_date
    return await call_tool("get_top_customers", args, _user)

@app.get("/customers/rfm", tags=["Customers"], summary="RFM customer segmentation")
async def rfm_segments(
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    _user=Depends(current_user),
):
    args: Dict[str, Any] = {}
    if from_date: args["fromDate"] = from_date
    if to_date:   args["toDate"]   = to_date
    return await call_tool("segment_customers_rfm", args, _user)

@app.get("/customers/churn-risk", tags=["Customers"], summary="Detect customers at churn risk")
async def churn_risk(
    days_inactive: int = 90,
    top: int = 20,
    _user=Depends(current_user),
):
    return await call_tool("detect_customer_churn", {"daysInactive": days_inactive, "topN": top}, _user)

@app.get("/customers/clv", tags=["Customers"], summary="Customer lifetime value")
async def customer_clv(top: int = 20, _user=Depends(current_user)):
    return await call_tool("calc_customer_clv", {"topN": top}, _user)

@app.get("/vendors", tags=["Vendors"], summary="List vendors / suppliers")
async def list_vendors(
    search: Optional[str] = None,
    top: int = 50,
    _user=Depends(current_user),
):
    args: Dict[str, Any] = {"topN": top}
    if search: args["search"] = search
    return await call_tool("get_vendor_list", args, _user)

@app.get("/vendors/lead-times", tags=["Vendors"], summary="Analyse vendor lead times")
async def vendor_lead_times(top: int = 20, _user=Depends(current_user)):
    return await call_tool("analyze_vendor_lead_time", {"topN": top}, _user)

@app.get("/vendors/on-time-delivery", tags=["Vendors"], summary="Vendor on-time delivery performance")
async def vendor_otd(top: int = 20, _user=Depends(current_user)):
    return await call_tool("analyze_on_time_delivery", {"topN": top}, _user)

@app.get("/vendors/concentration", tags=["Vendors"], summary="Vendor spend concentration (risk)")
async def vendor_concentration(
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    _user=Depends(current_user),
):
    args: Dict[str, Any] = {}
    if from_date: args["fromDate"] = from_date
    if to_date:   args["toDate"]   = to_date
    return await call_tool("analyze_vendor_concentration", args, _user)

# ── Analytics & Forecasting ───────────────────────────────────────────────────
@app.get("/analytics/sales", tags=["Analytics"], summary="Sales analysis (HANA SML or OData fallback)")
async def sales_analysis(
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    group_by: Optional[str] = None,
    top: int = 20,
    _user=Depends(current_user),
):
    args: Dict[str, Any] = {"topN": top}
    if from_date: args["fromDate"] = from_date
    if to_date:   args["toDate"]   = to_date
    if group_by:  args["groupBy"]  = group_by
    return await call_tool("get_sales_analysis", args, _user)

@app.get("/analytics/sales/by-period", tags=["Analytics"], summary="Sales grouped by period")
async def sales_by_period(
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    period: str = "month",
    _user=Depends(current_user),
):
    args: Dict[str, Any] = {"period": period}
    if from_date: args["fromDate"] = from_date
    if to_date:   args["toDate"]   = to_date
    return await call_tool("get_sales_by_period", args, _user)

@app.get("/analytics/sales/year-over-year", tags=["Analytics"], summary="Year-over-year sales comparison")
async def yoy(years: int = 2, _user=Depends(current_user)):
    return await call_tool("get_year_over_year", {"years": years}, _user)

@app.get("/analytics/sales/top-items", tags=["Analytics"], summary="Top selling items")
async def top_items(
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    top: int = 10,
    _user=Depends(current_user),
):
    args: Dict[str, Any] = {"topN": top}
    if from_date: args["fromDate"] = from_date
    if to_date:   args["toDate"]   = to_date
    return await call_tool("get_top_items", args, _user)

@app.get("/analytics/sales/by-salesperson", tags=["Analytics"], summary="Salesperson performance")
async def salesperson_perf(
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    _user=Depends(current_user),
):
    args: Dict[str, Any] = {}
    if from_date: args["fromDate"] = from_date
    if to_date:   args["toDate"]   = to_date
    return await call_tool("get_salesperson_performance", args, _user)

@app.get("/analytics/sales/by-warehouse", tags=["Analytics"], summary="Sales by warehouse")
async def warehouse_sales(
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    _user=Depends(current_user),
):
    args: Dict[str, Any] = {}
    if from_date: args["fromDate"] = from_date
    if to_date:   args["toDate"]   = to_date
    return await call_tool("get_warehouse_sales", args, _user)

@app.get("/analytics/sales/by-item-group", tags=["Analytics"], summary="Sales by item group")
async def item_group_sales(
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    _user=Depends(current_user),
):
    args: Dict[str, Any] = {}
    if from_date: args["fromDate"] = from_date
    if to_date:   args["toDate"]   = to_date
    return await call_tool("get_item_group_sales", args, _user)

@app.get("/analytics/purchase", tags=["Analytics"], summary="Purchase analysis by vendor")
async def purchase_analysis(
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    top: int = 10,
    _user=Depends(current_user),
):
    args: Dict[str, Any] = {"topN": top}
    if from_date: args["fromDate"] = from_date
    if to_date:   args["toDate"]   = to_date
    return await call_tool("get_purchase_analysis", args, _user)

@app.get("/analytics/quotation-win-rate", tags=["Analytics"], summary="Quotation win rate by customer")
async def quotation_win_rate(
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    top: int = 20,
    _user=Depends(current_user),
):
    args: Dict[str, Any] = {"topN": top}
    if from_date: args["fromDate"] = from_date
    if to_date:   args["toDate"]   = to_date
    return await call_tool("get_quotation_win_rate", args, _user)

@app.get("/analytics/abc-xyz", tags=["Analytics"], summary="ABC-XYZ inventory classification")
async def abc_xyz(
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    _user=Depends(current_user),
):
    args: Dict[str, Any] = {}
    if from_date: args["fromDate"] = from_date
    if to_date:   args["toDate"]   = to_date
    return await call_tool("analyze_abc_xyz", args, _user)

@app.get("/analytics/revenue-concentration", tags=["Analytics"], summary="Revenue concentration (Pareto)")
async def revenue_concentration(
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    _user=Depends(current_user),
):
    args: Dict[str, Any] = {}
    if from_date: args["fromDate"] = from_date
    if to_date:   args["toDate"]   = to_date
    return await call_tool("analyze_revenue_concentration", args, _user)

@app.get("/analytics/margin-erosion", tags=["Analytics"], summary="Detect margin erosion by item/customer")
async def margin_erosion(
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    _user=Depends(current_user),
):
    args: Dict[str, Any] = {}
    if from_date: args["fromDate"] = from_date
    if to_date:   args["toDate"]   = to_date
    return await call_tool("detect_margin_erosion", args, _user)

@app.get("/analytics/transaction-outliers", tags=["Analytics"], summary="Detect unusual transactions (z-score)")
async def transaction_outliers(
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    threshold: float = 2.5,
    _user=Depends(current_user),
):
    args: Dict[str, Any] = {"zThreshold": threshold}
    if from_date: args["fromDate"] = from_date
    if to_date:   args["toDate"]   = to_date
    return await call_tool("detect_transaction_outliers", args, _user)

@app.get("/analytics/seasonality", tags=["Analytics"], summary="Detect sales seasonality")
async def seasonality(_user=Depends(current_user)):
    return await call_tool("detect_seasonality", {}, _user)

# ── Forecasting ───────────────────────────────────────────────────────────────
@app.get("/forecast/sales", tags=["Forecasting"], summary="Forecast future sales")
async def forecast_sales(months_ahead: int = 3, _user=Depends(current_user)):
    return await call_tool("forecast_sales", {"monthsAhead": months_ahead}, _user)

@app.get("/forecast/demand/{item_code}", tags=["Forecasting"], summary="Forecast demand for a specific item")
async def forecast_demand(item_code: str, days_ahead: int = 30, _user=Depends(current_user)):
    return await call_tool("forecast_item_demand", {"itemCode": item_code, "daysAhead": days_ahead}, _user)

@app.get("/forecast/cash-flow", tags=["Forecasting"], summary="Cash flow forecast")
async def cash_flow_forecast(weeks_ahead: int = 8, _user=Depends(current_user)):
    return await call_tool("forecast_cash_flow", {"weeksAhead": weeks_ahead}, _user)

# ── Finance / Working Capital ─────────────────────────────────────────────────
@app.get("/finance/working-capital", tags=["Finance"], summary="Working capital analysis")
async def working_capital(_user=Depends(current_user)):
    return await call_tool("calc_working_capital", {}, _user)

# ── Company & Connections ─────────────────────────────────────────────────────
@app.get("/company/info", tags=["Company"], summary="Get SAP B1 company information")
async def company_info(_user=Depends(current_user)):
    return await call_tool("get_company_info", {}, _user)

@app.post("/company/switch", tags=["Company"], summary="Switch active company database")
async def switch_company(company_db: str, _user=Depends(current_user)):
    return await call_tool("switch_company", {"companyDB": company_db}, _user)

@app.get("/connections", tags=["Company"], summary="List SAP B1 connection profiles")
def list_connections(_user=Depends(current_user)):
    con = sqlite3.connect(str(DB_PATH))
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute(
            "SELECT id, name, base_url, company, sl_user, is_active, created_at FROM connections ORDER BY id"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        con.close()

# ── Raw Service Layer passthrough ────────────────────────────────────────────
class SLCallRequest(BaseModel):
    method: str = "GET"
    endpoint: str
    payload: Optional[Dict[str, Any]] = None
    params: Optional[str] = None

@app.post(
    "/service-layer/call",
    tags=["Service Layer"],
    summary="Raw Service Layer passthrough",
    description="Call any SAP B1 Service Layer endpoint directly. E.g. endpoint='/Orders?$top=5'",
)
async def service_layer_call(body: SLCallRequest, _user=Depends(current_user)):
    args: Dict[str, Any] = {"method": body.method, "endpoint": body.endpoint}
    if body.payload: args["payload"] = body.payload
    if body.params:  args["params"]  = body.params
    return await call_tool("call_service_layer", args, _user)

# ═══════════════════════════════════════════════════════════════════════════════
# Entry point
# ═══════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=API_PORT,
        reload=False,
        log_level="info",
    )
