terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }

  backend "s3" {
    bucket         = "sanad-tfstate"
    key            = "prod/terraform.tfstate"
    region         = "me-central-1"
    dynamodb_table = "sanad-tflock"
    encrypt        = true
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project     = "sanad"
      Environment = var.env
      ManagedBy   = "terraform"
    }
  }
}

variable "region" { default = "me-central-1" }
variable "env"    { default = "prod" }

data "aws_availability_zones" "available" { state = "available" }

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "sanad-${var.env}"
  cidr = "10.0.0.0/16"
  azs  = local.azs

  public_subnets  = ["10.0.1.0/24", "10.0.2.0/24"]

  private_subnets = ["10.0.10.0/24", "10.0.11.0/24"]

  database_subnets = ["10.0.20.0/24", "10.0.21.0/24"]

  enable_nat_gateway = true

  single_nat_gateway = true

  enable_dns_hostnames = true

  enable_flow_log                      = true
  create_flow_log_cloudwatch_log_group = true
  create_flow_log_cloudwatch_iam_role  = true

  tags = {
    "kubernetes.io/cluster/sanad-${var.env}" = "shared"
  }
  public_subnet_tags  = { "kubernetes.io/role/elb" = 1 }
  private_subnet_tags = { "kubernetes.io/role/internal-elb" = 1 }
}

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = "sanad-${var.env}"
  cluster_version = "1.30"

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  cluster_endpoint_public_access = true

  eks_managed_node_groups = {
    api = {
      instance_types = ["t3.medium"]
      min_size     = 2
      max_size     = 10
      desired_size = 3

      capacity_type = "ON_DEMAND"

      labels = { workload = "api" }
    }

    workers = {
      instance_types = ["t3.small"]
      min_size     = 1
      max_size     = 4
      desired_size = 2

      capacity_type = "SPOT"

      labels = { workload = "worker" }
      taints = [{
        key    = "workload"
        value  = "worker"
        effect = "NO_SCHEDULE"
      }]
    }
  }

  enable_irsa = true
}

resource "aws_db_subnet_group" "main" {
  name       = "sanad-${var.env}"
  subnet_ids = module.vpc.database_subnets
}

resource "aws_security_group" "rds" {
  name   = "sanad-rds-${var.env}"
  vpc_id = module.vpc.vpc_id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }

}

resource "aws_db_instance" "main" {
  identifier     = "sanad-${var.env}"
  engine         = "postgres"
  engine_version = "16.3"

  instance_class    = "db.t4g.medium"
  allocated_storage = 50
  max_allocated_storage = 200
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = "sanad"
  username = "sanad"
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  multi_az = true

  backup_retention_period = 14
  backup_window           = "01:00-02:00"
  maintenance_window      = "sun:02:00-sun:03:00"

  copy_tags_to_snapshot = true

  performance_insights_enabled = true
  enabled_cloudwatch_logs_exports = ["postgresql"]

  deletion_protection = true
  skip_final_snapshot = false
  final_snapshot_identifier = "sanad-${var.env}-final"

  lifecycle { ignore_changes = [engine_version] }
}

resource "aws_db_proxy" "main" {
  name          = "sanad-${var.env}"
  engine_family = "POSTGRESQL"
  role_arn      = aws_iam_role.rds_proxy.arn
  vpc_subnet_ids = module.vpc.database_subnets

  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "REQUIRED"
    secret_arn  = aws_db_instance.main.master_user_secret[0].secret_arn
  }

  require_tls = true
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = "sanad-${var.env}"
  description          = "Rate limiting + socket.io adapter"

  engine         = "redis"
  engine_version = "7.1"
  node_type      = "cache.t4g.micro"

  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true

  subnet_group_name  = aws_elasticache_subnet_group.redis.name
  security_group_ids = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true

  snapshot_retention_limit = 1
}

resource "aws_elasticache_subnet_group" "redis" {
  name       = "sanad-${var.env}"
  subnet_ids = module.vpc.private_subnets
}

resource "aws_security_group" "redis" {
  name   = "sanad-redis-${var.env}"
  vpc_id = module.vpc.vpc_id
  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }
}

resource "aws_msk_cluster" "main" {
  cluster_name           = "sanad-${var.env}"
  kafka_version          = "3.6.0"
  number_of_broker_nodes = 2

  broker_node_group_info {
    instance_type   = "kafka.t3.small"
    client_subnets  = module.vpc.private_subnets
    security_groups = [aws_security_group.msk.id]
    storage_info {
      ebs_storage_info { volume_size = 20 }
    }
  }

  encryption_info {
    encryption_in_transit {
      client_broker = "TLS"
      in_cluster    = true
    }
  }

  client_authentication {
    sasl { iam = true }
  }
}

resource "aws_security_group" "msk" {
  name   = "sanad-msk-${var.env}"
  vpc_id = module.vpc.vpc_id
  ingress {
    from_port       = 9098
    to_port         = 9098
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }
}

resource "aws_s3_bucket" "media" {
  bucket = "sanad-${var.env}-media"
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_versioning" "media" {
  bucket = aws_s3_bucket.media.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  rule {
    id     = "tier-proof-media"
    status = "Enabled"

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }
    transition {
      days          = 180
      storage_class = "GLACIER_IR"
    }
  }
}

resource "aws_iam_role" "api" {
  name = "sanad-api-${var.env}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = module.eks.oidc_provider_arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${module.eks.oidc_provider}:sub" = "system:serviceaccount:sanad:sanad-api"
          "${module.eks.oidc_provider}:aud" = "sts.amazonaws.com"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "api_s3" {
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:PutObject", "s3:GetObject"]
      Resource = "${aws_s3_bucket.media.arn}/*"
    }]
  })
}

resource "aws_iam_role_policy" "api_secrets" {
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = aws_db_instance.main.master_user_secret[0].secret_arn
    }]
  })
}

resource "aws_iam_role" "rds_proxy" {
  name = "sanad-rds-proxy-${var.env}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "rds.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_cloudfront_distribution" "media" {
  enabled = true

  origin {
    domain_name              = aws_s3_bucket.media.bucket_regional_domain_name
    origin_id                = "s3-media"
    origin_access_control_id = aws_cloudfront_origin_access_control.media.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-media"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]

    trusted_key_groups = [aws_cloudfront_key_group.media.id]

    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate { cloudfront_default_certificate = true }
}

resource "aws_cloudfront_origin_access_control" "media" {
  name                              = "sanad-media"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_key_group" "media" {
  name  = "sanad-media-keys"
  items = [aws_cloudfront_public_key.media.id]
}

resource "aws_cloudfront_public_key" "media" {
  name        = "sanad-media-signer"
  encoded_key = file("${path.module}/cloudfront-public-key.pem")
}

output "cluster_endpoint" { value = module.eks.cluster_endpoint }
output "rds_proxy_endpoint" { value = aws_db_proxy.main.endpoint }
output "redis_endpoint" { value = aws_elasticache_replication_group.redis.primary_endpoint_address }
output "kafka_brokers" { value = aws_msk_cluster.main.bootstrap_brokers_sasl_iam }
output "media_bucket" { value = aws_s3_bucket.media.id }
output "media_cdn" { value = aws_cloudfront_distribution.media.domain_name }
