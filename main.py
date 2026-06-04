from datetime import datetime, timedelta
from enum import Enum
from typing import Dict, List, Optional
from uuid import uuid4

from fastapi import FastAPI, Header, HTTPException, Query, Request, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

app = FastAPI(
    title="Smart Campus — IoT Ingestion",
    version="1.0.0",
    description="Local backend implementation for FIT4110 Lab 03 tests.",
)

VALID_TOKEN = "local-dev-token"
RATE_LIMIT_WINDOW_SECONDS = 1.0
RATE_LIMIT_MAX = 5
RATE_LIMIT_HISTORY: Dict[str, List[datetime]] = {}
READINGS_DB: List[Dict] = []


class ProblemDetails(BaseModel):
    type: str
    title: str
    status: int
    detail: str
    instance: str


class HealthStatus(BaseModel):
    status: str = "ok"
    service: str = "iot-ingestion"
    time: datetime = Field(default_factory=datetime.utcnow)


class Metric(str, Enum):
    temperature = "temperature"
    humidity = "humidity"
    pressure = "pressure"


class Unit(str, Enum):
    celsius = "celsius"
    percent = "percent"
    pascal = "pascal"


class CreateReadingRequest(BaseModel):
    device_id: str
    metric: Metric
    value: float = Field(..., ge=-40, le=80)
    unit: Unit
    timestamp: datetime


class ReadingCreated(BaseModel):
    reading_id: str
    device_id: str
    metric: Metric
    unit: Unit
    value: float
    timestamp: datetime
    accepted: bool


class ReadingPage(BaseModel):
    items: List[ReadingCreated]
    hasMore: bool
    nextCursor: Optional[str] = None


def problem_details(
    request: Request,
    status_code: int,
    title: str,
    detail: str,
    type_: Optional[str] = None,
) -> JSONResponse:
    payload = {
        "type": type_ or f"https://smart-campus.local/problems/{status_code}",
        "title": title,
        "status": status_code,
        "detail": detail,
        "instance": request.url.path,
    }
    return JSONResponse(status_code=status_code, content=payload, media_type="application/problem+json")


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return problem_details(
        request,
        exc.status_code,
        exc.detail if isinstance(exc.detail, str) else "HTTP error",
        exc.detail if isinstance(exc.detail, str) else str(exc.detail),
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    detail = "; ".join(
        [f"{err.get('loc')}: {err.get('msg')}" for err in exc.errors()]
    )
    return problem_details(
        request,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "Unprocessable Entity",
        detail,
    )


def validate_auth(authorization: Optional[str] = Header(None)) -> None:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid bearer token",
        )
    token = authorization.split(" ", 1)[1]
    if token != VALID_TOKEN:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid bearer token",
        )


def is_rate_limited(reading: CreateReadingRequest) -> bool:
    key = f"{reading.device_id}:{reading.metric}:{reading.unit}:{reading.value}"
    now = datetime.utcnow()
    cutoff = now - timedelta(seconds=RATE_LIMIT_WINDOW_SECONDS)
    history = RATE_LIMIT_HISTORY.get(key, [])
    history = [t for t in history if t > cutoff]
    history.append(now)
    RATE_LIMIT_HISTORY[key] = history
    return len(history) > RATE_LIMIT_MAX


@app.get("/health", response_model=HealthStatus)
async def get_health():
    return HealthStatus()


@app.head("/health")
async def health_head():
    return Response(status_code=status.HTTP_200_OK)


@app.post("/readings", response_model=ReadingCreated, status_code=status.HTTP_201_CREATED)
async def create_reading(
    reading: CreateReadingRequest,
    request: Request,
    authorization: Optional[str] = Header(None),
):
    validate_auth(authorization)
    if is_rate_limited(reading):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Rate limit exceeded",
        )

    created = ReadingCreated(
        reading_id=str(uuid4()),
        device_id=reading.device_id,
        metric=reading.metric,
        unit=reading.unit,
        value=reading.value,
        timestamp=reading.timestamp,
        accepted=True,
    )
    READINGS_DB.append(created.dict())
    return created


@app.get("/readings/latest", response_model=ReadingPage)
async def get_latest_readings(
    request: Request,
    authorization: Optional[str] = Header(None),
    device_id: Optional[str] = None,
    limit: int = Query(20, ge=1, le=100),
):
    validate_auth(authorization)
    filtered = [item for item in READINGS_DB if device_id is None or item["device_id"] == device_id]
    sorted_items = sorted(
        filtered,
        key=lambda item: item["timestamp"],
        reverse=True,
    )
    items = [ReadingCreated(**item) for item in sorted_items[:limit]]
    return ReadingPage(items=items, hasMore=len(sorted_items) > len(items))
